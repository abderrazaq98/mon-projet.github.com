const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const db = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

function normalizeKey(s) {
  return String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
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
    geometry ?? existing.geometry,
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
    const nom = map['nom'] ?? map['nom secteur'] ?? map['nom du secteur'] ?? null;
    const agence = map['agence'] ?? map['agence nom'] ?? null;
    const color = map['color'] ?? map['couleur'] ?? map['color hex'] ?? '#1e5f8a';

    if (numero || nom) {
      previewSectors.push({ numero, nom, agence, color, geometry: null });
    } else {
      errors.push({ row: i + 1, reason: 'Numéro ou nom de secteur manquant' });
    }
  }

  res.json({ total: rows.length, preview: previewSectors, errors });
});

// ---- Import secteurs SHP (preview) ----
router.post('/sectors/import-shp-preview', requireAuth, upload.single('file'), async (req, res) => {
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

    const shpBuffer = shpEntry.getData();
    const dbfBuffer = dbfEntry ? dbfEntry.getData() : undefined;

    // Auto-detect projection
    let projection = 'WGS84';
    if (prjEntry) {
      const prjContent = prjEntry.getData().toString('utf8').toLowerCase();
      if (prjContent.includes('lambert') || prjContent.includes('merchich') || prjContent.includes('ct_maroc')) {
        projection = 'Lambert';
      }
    }

    const source = await shapefile.open(shpBuffer, dbfBuffer);
    const previewSectors = [];
    let total = 0;

    let result = await source.read();
    while (!result.done && previewSectors.length < 50) {
      total++;
      const feature = result.value;
      if (!feature.geometry) { result = await source.read(); continue; }

      const props = feature.properties || {};
      const map = {};
      for (const key of Object.keys(props)) map[normalizeKey(key)] = props[key];

      const numero = map['numero'] ?? map['num'] ?? map['n'] ?? null;
      const nom = map['nom'] ?? map['nom secteur'] ?? map['name'] ?? null;
      const agence = map['agence'] ?? map['agence nom'] ?? null;
      const color = map['color'] ?? map['couleur'] ?? '#1e5f8a';

      let geometry = null;

      // For polygons/lines, convert coordinates to WGS84 if needed
      if (feature.geometry.coordinates) {
        const geoCoords = convertGeoCoords(feature.geometry, projection);
        geometry = JSON.stringify(geoCoords);
      }

      previewSectors.push({
        numero: numero != null ? String(numero) : null,
        nom: nom != null ? String(nom) : null,
        agence: agence != null ? String(agence) : null,
        color: color || '#1e5f8a',
        geometry,
      });
      result = await source.read();
    }

    while (!result.done) {
      total++;
      result = await source.read();
    }

    res.json({
      projection,
      total,
      preview: previewSectors,
    });
  } catch (e) {
    res.status(400).json({ error: 'Fichier SHP illisible: ' + e.message });
  }
});

// Helper: convert GeoJSON coordinates based on projection
function convertGeoCoords(geometry, projection) {
  if (!geometry) return geometry;
  const { lambertToWGS84, wgs84ToLambert } = require('../coords');

  function convertCoord(coord) {
    if (projection === 'Lambert') {
      const [x, y] = coord;
      const wgs = lambertToWGS84(x, y);
      return [wgs.lng, wgs.lat];
    }
    return coord; // already WGS84
  }

  function convertCoords(coords) {
    if (typeof coords[0] === 'number') {
      return convertCoord(coords);
    }
    return coords.map(convertCoords);
  }

  return {
    ...geometry,
    coordinates: convertCoords(geometry.coordinates),
  };
}

// ---- Import secteurs SHP (confirm) ----
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

    const shpBuffer = shpEntry.getData();
    const dbfBuffer = dbfEntry ? dbfEntry.getData() : undefined;

    let projection = 'WGS84';
    if (prjEntry) {
      const prjContent = prjEntry.getData().toString('utf8').toLowerCase();
      if (prjContent.includes('lambert') || prjContent.includes('merchich') || prjContent.includes('ct_maroc')) {
        projection = 'Lambert';
      }
    }

    const source = await shapefile.open(shpBuffer, dbfBuffer);

    const insert = db.prepare(`
      INSERT INTO sectors (numero, nom, agence, color, geometry)
      VALUES (?, ?, ?, ?, ?)
    `);

    let imported = 0;
    let errors = 0;
    let total = 0;

    db.exec('BEGIN');
    try {
      let result = await source.read();
      while (!result.done) {
        total++;
        const feature = result.value;
        if (!feature.geometry) { errors++; result = await source.read(); continue; }

        const props = feature.properties || {};
        const map = {};
        for (const key of Object.keys(props)) map[normalizeKey(key)] = props[key];

        const numero = map['numero'] ?? map['num'] ?? map['n'] ?? null;
        const nom = map['nom'] ?? map['nom secteur'] ?? map['name'] ?? null;
        const agence = map['agence'] ?? map['agence nom'] ?? null;
        const color = map['color'] ?? map['couleur'] ?? '#1e5f8a';

        let geometry = null;
        if (feature.geometry.coordinates) {
          const geoCoords = convertGeoCoords(feature.geometry, projection);
          geometry = JSON.stringify(geoCoords);
        }

        insert.run(
          numero != null ? String(numero) : null,
          nom != null ? String(nom) : null,
          agence != null ? String(agence) : null,
          color || '#1e5f8a',
          geometry
        );
        imported++;
        result = await source.read();
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      return res.status(500).json({ error: 'Erreur pendant l\'import SHP secteurs: ' + e.message });
    }
    res.json({ imported, errors, total });
  } catch (e) {
    res.status(400).json({ error: 'Fichier SHP illisible: ' + e.message });
  }
});

module.exports = router;