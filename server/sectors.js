const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const db = require('../db');
const { lambertToWGS84, wgs84ToLambert, PROJECTIONS } = require('../coords');
const { requireAuth } = require('../auth');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

function normalizeKey(s) {
  return String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
}

// Helper: detect projection from .prj content
function detectProjectionFromPrj(prjContent) {
  if (!prjContent) return 'WGS84';
  const str = prjContent.toLowerCase();
  if (str.includes('clrk80') || str.includes('clarke_1880_ign') || str.includes('merchich')) {
    if (str.includes('lat_1=33.3')) return 'LAMBERT_NORD';
    if (str.includes('lat_1=29.7')) return 'LAMBERT_CENTRE';
    if (str.includes('lat_1=26.0')) return 'LAMBERT_SUD';
    if (str.includes('lat_1=26.7')) return 'LAMBERT_SAHARA';
    return 'LAMBERT_NORD';
  }
  return 'WGS84';
}

// Helper: convert a single coordinate based on detected projection
function convertCoords(x, y, projection) {
  if (projection === 'WGS84') {
    return { lat: y, lng: x };
  } else {
    return lambertToWGS84(x, y);
  }
}

// Helper: recursively convert GeoJSON coordinates from Lambert to WGS84
function convertGeoCoords(geometry, projection) {
  if (projection === 'WGS84') return geometry;

  function convertCoordArray(coords) {
    if (typeof coords[0] === 'number' && typeof coords[1] === 'number') {
      const result = convertCoords(coords[0], coords[1], projection);
      return [result.lng, result.lat];
    }
    return coords.map(c => convertCoordArray(c));
  }

  const g = { ...geometry };
  if (g.coordinates) {
    g.coordinates = convertCoordArray(g.coordinates);
  }
  return g;
}

// ---- Liste des secteurs ----
router.get('/sectors', (req, res) => {
  const { q } = req.query;
  if (q) {
    const stmt = db.prepare('SELECT * FROM sectors WHERE numero LIKE ? OR nom LIKE ? ORDER BY id DESC');
    const rows = stmt.all(`%${q}%`, `%${q}%`);
    return res.json(rows);
  }
  const stmt = db.prepare('SELECT * FROM sectors ORDER BY id DESC');
  const rows = stmt.all();
  res.json(rows);
});

router.get('/sectors/:id', (req, res) => {
  const stmt = db.prepare('SELECT * FROM sectors WHERE id = ?');
  const row = stmt.get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Secteur introuvable' });
  res.json(row);
});

// ---- Créer un secteur ----
router.post('/sectors', requireAuth, (req, res) => {
  const { numero, nom, agence, color, geometry } = req.body;
  const stmt = db.prepare(`
    INSERT INTO sectors (numero, nom, agence, color, geometry)
    VALUES (?, ?, ?, ?, ?)
  `);
  const info = stmt.run(
    numero || null,
    nom || null,
    agence || null,
    color || '#1e5f8a',
    geometry || null
  );
  const created = db.prepare('SELECT * FROM sectors WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json(created);
});

// ---- Modifier un secteur ----
router.put('/sectors/:id', requireAuth, (req, res) => {
  const existing = db.prepare('SELECT * FROM sectors WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Secteur introuvable' });

  const { numero, nom, agence, color, geometry } = req.body;
  const stmt = db.prepare(`
    UPDATE sectors SET numero = ?, nom = ?, agence = ?, color = ?, geometry = ?, date_modification = CURRENT_TIMESTAMP
    WHERE id = ?
  `);
  stmt.run(
    numero ?? existing.numero,
    nom ?? existing.nom,
    agence ?? existing.agence,
    color ?? existing.color,
    geometry !== undefined ? geometry : existing.geometry,
    req.params.id
  );

  const updated = db.prepare('SELECT * FROM sectors WHERE id = ?').get(req.params.id);
  res.json(updated);
});

// ---- Supprimer un secteur ----
router.delete('/sectors/:id', requireAuth, (req, res) => {
  const stmt = db.prepare('DELETE FROM sectors WHERE id = ?');
  const info = stmt.run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Secteur introuvable' });
  res.json({ success: true });
});

// ---- Suppression groupée ----
router.delete('/sectors', requireAuth, (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'Aucun identifiant fourni' });
  }
  const stmt = db.prepare('DELETE FROM sectors WHERE id = ?');
  let deleted = 0;
  db.exec('BEGIN');
  try {
    for (const id of ids) {
      const info = stmt.run(id);
      deleted += info.changes;
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    return res.status(500).json({ error: 'Erreur pendant la suppression: ' + e.message });
  }
  res.json({ success: true, deleted });
});

// ---- Import secteurs (Excel) ----
router.post('/sectors/import', requireAuth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Aucun fichier reçu' });

  let workbook;
  try {
    workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
  } catch (e) {
    return res.status(400).json({ error: 'Fichier Excel illisible' });
  }

  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: null });
  if (rows.length === 0) {
    return res.status(400).json({ error: 'Le fichier ne contient aucune ligne' });
  }

  const insert = db.prepare(`
    INSERT INTO sectors (numero, nom, agence, color, geometry)
    VALUES (?, ?, ?, ?, ?)
  `);

  let imported = 0;
  let errors = 0;
  db.exec('BEGIN');
  try {
    for (const row of rows) {
      const map = {};
      for (const key of Object.keys(row)) {
        map[normalizeKey(key)] = row[key];
      }
      const numero = map['numero'] ?? map['num'] ?? map['n'] ?? null;
      const nom = map['nom'] ?? map['nom secteur'] ?? map['nom du secteur'] ?? null;
      const agence = map['agence'] ?? map['agence nom'] ?? null;
      const color = map['color'] ?? map['couleur'] ?? map['color hex'] ?? '#1e5f8a';
      const geometry = map['geometry'] ?? map['geojson'] ?? map['forme'] ?? null;

      if (!numero && !nom) { errors++; continue; }

      insert.run(
        numero != null ? String(numero) : null,
        nom != null ? String(nom) : null,
        agence != null ? String(agence) : null,
        color || '#1e5f8a',
        geometry || null
      );
      imported++;
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    return res.status(500).json({ error: 'Erreur pendant l\'import: ' + e.message });
  }
  res.json({ imported, errors, total: rows.length });
});

// ---- Preview import secteurs ----
router.post('/sectors/import/preview', requireAuth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Aucun fichier reçu' });

  let workbook;
  try {
    workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
  } catch (e) {
    return res.status(400).json({ error: 'Fichier Excel illisible' });
  }

  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: null });

  const previewSectors = [];
  const errors = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const map = {};
    for (const key of Object.keys(row)) {
      map[normalizeKey(key)] = row[key];
    }
    const numero = map['numero'] ?? map['num'] ?? map['n'] ?? null;
    const nom = map['nom'] ?? map['nom secteur'] ?? null;
    const agence = map['agence'] ?? null;
    const color = map['color'] ?? map['couleur'] ?? '#1e5f8a';

    if (numero || nom) {
      previewSectors.push({ numero, nom, agence, color });
    } else {
      errors.push({ row: i + 1, reason: 'Numéro ou nom de secteur manquant' });
    }
  }

  res.json({ total: rows.length, preview: previewSectors, errors });
});

// ---- Import secteurs SHP (ZIP) with auto-detect projection ----
router.post('/sectors/import-shp', requireAuth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Aucun fichier reçu' });

  let AdmZip, shapefile;
  try {
    AdmZip = require('adm-zip');
    shapefile = require('shapefile');
  } catch (e) {
    return res.status(500).json({
      error: 'Dépendances manquantes. Exécutez : npm install shapefile adm-zip',
    });
  }

  try {
    const zip = new AdmZip(req.file.buffer);
    const entries = zip.getEntries();
    const shpEntry = entries.find((e) => e.entryName.toLowerCase().endsWith('.shp'));
    const dbfEntry = entries.find((e) => e.entryName.toLowerCase().endsWith('.dbf'));
    const prjEntry = entries.find((e) => e.entryName.toLowerCase().endsWith('.prj'));

    if (!shpEntry) return res.status(400).json({ error: 'Le zip ne contient pas de fichier .shp' });

    let projection = 'WGS84';
    if (prjEntry) {
      const prjContent = prjEntry.getData().toString('utf8');
      projection = detectProjectionFromPrj(prjContent);
    }

    const shpBuffer = shpEntry.getData();
    const dbfBuffer = dbfEntry ? dbfEntry.getData() : undefined;
    const source = await shapefile.open(shpBuffer, dbfBuffer);

    let imported = 0;
    let errors = 0;
    let total = 0;
    const sectorGeometries = []; // Collect geometries for response

    db.exec('BEGIN');
    try {
      let result = await source.read();
      while (!result.done) {
        total++;
        const feature = result.value;
        const geom = feature.geometry;
        if (!geom) { errors++; result = await source.read(); continue; }

        const props = feature.properties || {};
        const map = {};
        for (const key of Object.keys(props)) map[normalizeKey(key)] = props[key];

        const numero = map['numero'] ?? map['num'] ?? map['n'] ?? null;
        const nom = map['nom'] ?? map['nom secteur'] ?? map['nom du secteur'] ?? null;
        const agence = map['agence'] ?? null;
        const color = map['color'] ?? map['couleur'] ?? '#1e5f8a';

        if (!numero && !nom) { errors++; result = await source.read(); continue; }

        // Convert geometry to WGS84 GeoJSON
        const wgs84Geom = convertGeoCoords(geom, projection);
        const geometryStr = JSON.stringify(wgs84Geom);

        const stmt = db.prepare(`
          INSERT INTO sectors (numero, nom, agence, color, geometry)
          VALUES (?, ?, ?, ?, ?)
        `);
        const info = stmt.run(
          numero != null ? String(numero) : null,
          nom != null ? String(nom) : null,
          agence != null ? String(agence) : null,
          color || '#1e5f8a',
          geometryStr
        );

        sectorGeometries.push({ id: info.lastInsertRowid, numero, nom, geometry: wgs84Geom });
        imported++;
        result = await source.read();
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      return res.status(500).json({ error: 'Erreur pendant l\'import SHP: ' + e.message });
    }
    res.json({ imported, errors, total, projection, sectors: sectorGeometries });
  } catch (e) {
    res.status(400).json({ error: 'Fichier SHP illisible: ' + e.message });
  }
});

// ---- Import secteurs KML ----
router.post('/sectors/import-kml', requireAuth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Aucun fichier reçu' });

  const xml = req.file.buffer.toString('utf8');
  const placemarkRegex = /<Placemark>([\s\S]*?)<\/Placemark>/gi;
  const placemarks = xml.match(placemarkRegex) || [];

  if (placemarks.length === 0) {
    return res.status(400).json({ error: 'Aucun Placemark trouvé dans le fichier KML' });
  }

  let imported = 0;
  let errors = 0;
  const sectorGeometries = [];

  db.exec('BEGIN');
  try {
    for (const pm of placemarks) {
      const nameMatch = pm.match(/<name>([\s\S]*?)<\/name>/);
      const nom = nameMatch ? nameMatch[1].trim() : null;

      // Try to extract polygon or linestring geometry
      let geometry = null;

      // Polygon
      const polygonMatch = pm.match(/<Polygon>[\s\S]*?<outerBoundaryIs>[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>[\s\S]*?<\/outerBoundaryIs>[\s\S]*?<\/Polygon>/i);
      if (polygonMatch) {
        const coordStr = polygonMatch[1].trim();
        const coords = coordStr.split(/\s+/).map(c => {
          const [lng, lat] = c.split(',').map(Number);
          return [lng, lat];
        });
        if (coords.length >= 3) {
          geometry = { type: 'Polygon', coordinates: [coords] };
        }
      }

      // LineString (fallback)
      if (!geometry) {
        const lineMatch = pm.match(/<LineString>[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>[\s\S]*?<\/LineString>/i);
        if (lineMatch) {
          const coordStr = lineMatch[1].trim();
          const coords = coordStr.split(/\s+/).map(c => {
            const [lng, lat] = c.split(',').map(Number);
            return [lng, lat];
          });
          if (coords.length >= 2) {
            geometry = { type: 'LineString', coordinates: coords };
          }
        }
      }

      // ExtendedData for attributes
      const dataFields = {};
      const dataRegex = /<Data\s+name="([^"]+)">\s*<value>([\s\S]*?)<\/value>\s*<\/Data>/gi;
      let m;
      while ((m = dataRegex.exec(pm)) !== null) {
        dataFields[normalizeKey(m[1])] = m[2].trim();
      }
      const extDataRegex = /<SimpleData\s+name="([^"]+)">(.*?)<\/SimpleData>/gi;
      while ((m = extDataRegex.exec(pm)) !== null) {
        if (!dataFields[normalizeKey(m[1])]) {
          dataFields[normalizeKey(m[1])] = m[2].trim();
        }
      }

      const numero = dataFields['numero'] ?? dataFields['num'] ?? null;
      const agence = dataFields['agence'] ?? null;
      const color = dataFields['color'] ?? dataFields['couleur'] ?? '#1e5f8a';

      if (!nom && !numero) { errors++; continue; }

      const geometryStr = geometry ? JSON.stringify(geometry) : null;

      const stmt = db.prepare(`
        INSERT INTO sectors (numero, nom, agence, color, geometry)
        VALUES (?, ?, ?, ?, ?)
      `);
      const info = stmt.run(
        numero != null ? String(numero) : null,
        nom || null,
        agence || null,
        color || '#1e5f8a',
        geometryStr
      );

      sectorGeometries.push({ id: info.lastInsertRowid, numero, nom, geometry });
      imported++;
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    return res.status(500).json({ error: 'Erreur pendant l\'import KML: ' + e.message });
  }
  res.json({ imported, errors, total: placemarks.length, sectors: sectorGeometries });
});

// ---- Preview geometry from file (for sector modal) ----
router.post('/sectors/geometry/preview', requireAuth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Aucun fichier reçu' });

  const filename = req.file.originalname.toLowerCase();
  let geometry = null;

  try {
    if (filename.endsWith('.zip')) {
      // SHP ZIP
      let AdmZip, shapefile;
      try {
        AdmZip = require('adm-zip');
        shapefile = require('shapefile');
      } catch (e) {
        return res.status(500).json({ error: 'Dépendances manquantes' });
      }

      const zip = new AdmZip(req.file.buffer);
      const entries = zip.getEntries();
      const shpEntry = entries.find((e) => e.entryName.toLowerCase().endsWith('.shp'));
      const dbfEntry = entries.find((e) => e.entryName.toLowerCase().endsWith('.dbf'));
      const prjEntry = entries.find((e) => e.entryName.toLowerCase().endsWith('.prj'));

      if (!shpEntry) return res.status(400).json({ error: 'Le zip ne contient pas de fichier .shp' });

      let projection = 'WGS84';
      if (prjEntry) {
        const prjContent = prjEntry.getData().toString('utf8');
        projection = detectProjectionFromPrj(prjContent);
      }

      const shpBuffer = shpEntry.getData();
      const dbfBuffer = dbfEntry ? dbfEntry.getData() : undefined;
      const source = await shapefile.open(shpBuffer, dbfBuffer);

      // Read first feature for preview
      let result = await source.read();
      if (!result.done && result.value && result.value.geometry) {
        geometry = convertGeoCoords(result.value.geometry, projection);
        // Collect all features if multiple
        if (result.value.geometry.type === 'Polygon' || result.value.geometry.type === 'MultiPolygon') {
          // Read remaining to check for MultiPolygon
          const features = [result.value];
          while (!(result = await source.read()).done) {
            if (result.value && result.value.geometry) features.push(result.value);
          }
          if (features.length === 1) {
            geometry = convertGeoCoords(features[0].geometry, projection);
          } else {
            // Create MultiPolygon
            const polygons = features.map(f => {
              const g = convertGeoCoords(f.geometry, projection);
              if (g.type === 'Polygon') return g.coordinates;
              if (g.type === 'MultiPolygon') return g.coordinates;
              return null;
            }).filter(Boolean);
            geometry = { type: 'MultiPolygon', coordinates: polygons };
          }
        } else {
          geometry = convertGeoCoords(result.value.geometry, projection);
        }
      }
    } else if (filename.endsWith('.kml')) {
      // KML file
      const xml = req.file.buffer.toString('utf8');
      const placemarkRegex = /<Placemark>([\s\S]*?)<\/Placemark>/gi;
      const placemarks = xml.match(placemarkRegex) || [];

      if (placemarks.length > 0) {
        const pm = placemarks[0]; // Use first placemark
        const polygonMatch = pm.match(/<Polygon>[\s\S]*?<outerBoundaryIs>[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>[\s\S]*?<\/outerBoundaryIs>[\s\S]*?<\/Polygon>/i);
        if (polygonMatch) {
          const coordStr = polygonMatch[1].trim();
          const coords = coordStr.split(/\s+/).map(c => {
            const [lng, lat] = c.split(',').map(Number);
            return [lng, lat];
          });
          if (coords.length >= 3) {
            geometry = { type: 'Polygon', coordinates: [coords] };
          }
        }
        const lineMatch = pm.match(/<LineString>[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>[\s\S]*?<\/LineString>/i);
        if (!geometry && lineMatch) {
          const coordStr = lineMatch[1].trim();
          const coords = coordStr.split(/\s+/).map(c => {
            const [lng, lat] = c.split(',').map(Number);
            return [lng, lat];
          });
          if (coords.length >= 2) {
            geometry = { type: 'LineString', coordinates: coords };
          }
        }
      }
    } else if (filename.endsWith('.json') || filename.endsWith('.geojson')) {
      // GeoJSON file
      const jsonStr = req.file.buffer.toString('utf8');
      const parsed = JSON.parse(jsonStr);
      if (parsed.type === 'Feature') {
        geometry = parsed.geometry;
      } else if (parsed.type === 'FeatureCollection') {
        // Merge all features into a MultiPolygon or use first
        if (parsed.features && parsed.features.length > 0) {
          if (parsed.features.length === 1) {
            geometry = parsed.features[0].geometry;
          } else {
            const polygons = parsed.features
              .filter(f => f.geometry && (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon'))
              .map(f => f.geometry.type === 'Polygon' ? f.geometry.coordinates : f.geometry.coordinates);
            geometry = { type: 'MultiPolygon', coordinates: polygons };
          }
        }
      } else if (parsed.coordinates) {
        geometry = parsed;
      }
    }

    if (!geometry) {
      return res.status(400).json({ error: 'Aucune géométrie trouvée dans le fichier' });
    }

    res.json({ geometry, projection: filename.endsWith('.zip') ? (req.body?.projection || 'auto') : 'WGS84' });
  } catch (e) {
    res.status(400).json({ error: 'Erreur lors de la lecture du fichier: ' + e.message });
  }
});

module.exports = router;
