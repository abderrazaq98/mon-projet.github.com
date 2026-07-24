const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const db = require('../db');
const { lambertToWGS84, wgs84ToLambert } = require('../coords');
const { requireAuth } = require('../auth');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

function rowToPublic(row) {
  return {
    id: row.id,
    ig: row.ig,
    adresse: row.adresse,
    numero_batiment: row.numero_batiment,
    secteur_nom: row.secteur_nom,
    secteur_numero: row.secteur_numero,
    x: row.x,
    y: row.y,
    lat: row.lat,
    lng: row.lng,
    commentaire: row.commentaire,
  };
}

function normalizeKey(s) {
  return String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
}

// ---- Conversion GPS -> Lambert ----
router.get('/convert-coords', requireAuth, (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);
  if (Number.isNaN(lat) || Number.isNaN(lng)) {
    return res.status(400).json({ error: 'lat et lng requis' });
  }
  const { x, y } = wgs84ToLambert(lat, lng);
  res.json({ x, y });
});

// ---- Recherche / liste publique ----
router.get('/points', (req, res) => {
  const { q, type, limit, secteur } = req.query;
  const max = Math.min(Number(limit) || 2000, 5000);
  let rows;

  if (!q) {
    let sql = 'SELECT * FROM points';
    if (secteur) {
      sql += ' WHERE secteur_numero LIKE ? OR secteur_nom LIKE ?';
      const stmt = db.prepare(sql + ' ORDER BY id DESC LIMIT ?');
      rows = stmt.all(`%${secteur}%`, `%${secteur}%`, max);
    } else {
      const stmt = db.prepare(sql + ' ORDER BY id DESC LIMIT ?');
      rows = stmt.all(max);
    }
  } else if (type === 'coord') {
    const parts = q.split(',').map((s) => parseFloat(s.trim()));
    if (parts.length !== 2 || parts.some(Number.isNaN)) {
      return res.status(400).json({ error: 'Format attendu: "lat, lng"' });
    }
    const [lat, lng] = parts;
    const stmt = db.prepare(`
      SELECT *, ((lat - ?) * (lat - ?) + (lng - ?) * (lng - ?)) AS dist
      FROM points
      ORDER BY dist ASC
      LIMIT ?
    `);
    rows = stmt.all(lat, lat, lng, lng, max);
  } else if (type === 'ig') {
    const stmt = db.prepare('SELECT * FROM points WHERE ig LIKE ? ORDER BY id DESC LIMIT ?');
    rows = stmt.all(`%${q}%`, max);
  } else if (type === 'adresse') {
    const stmt = db.prepare('SELECT * FROM points WHERE adresse LIKE ? ORDER BY id DESC LIMIT ?');
    rows = stmt.all(`%${q}%`, max);
  } else if (type === 'batiment') {
    const stmt = db.prepare('SELECT * FROM points WHERE numero_batiment LIKE ? ORDER BY id DESC LIMIT ?');
    rows = stmt.all(`%${q}%`, max);
  } else {
    // recherche libre sur IG + adresse + numéro de bâtiment + secteur
    const stmt = db.prepare(
      'SELECT * FROM points WHERE ig LIKE ? OR adresse LIKE ? OR numero_batiment LIKE ? OR secteur_nom LIKE ? OR secteur_numero LIKE ? ORDER BY id DESC LIMIT ?'
    );
    rows = stmt.all(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, max);
  }

  res.json(rows.map(rowToPublic));
});

router.get('/points/:id', (req, res) => {
  const stmt = db.prepare('SELECT * FROM points WHERE id = ?');
  const row = stmt.get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Point introuvable' });
  res.json(rowToPublic(row));
});

// ---- Export Excel ----
router.post('/export', requireAuth, (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'Aucun identifiant fourni' });
  }
  const stmt = db.prepare('SELECT * FROM points WHERE id = ?');
  const rows = [];
  for (const id of ids) {
    const row = stmt.get(id);
    if (row) rows.push(row);
  }
  if (rows.length === 0) {
    return res.status(404).json({ error: 'Aucun point trouvé' });
  }
  const data = rows.map((r) => ({
    ID: r.id,
    'Identifiant géographique': r.ig || '',
    'Adresse': r.adresse || '',
    'N° Bâtiment': r.numero_batiment || '',
    'Secteur nom': r.secteur_nom || '',
    'Secteur numéro': r.secteur_numero || '',
    'X': r.x != null ? r.x : '',
    'Y': r.y != null ? r.y : '',
    'Latitude': r.lat != null ? r.lat : '',
    'Longitude': r.lng != null ? r.lng : '',
    'Commentaire': r.commentaire || '',
  }));
  const ws = XLSX.utils.json_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Points');
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.set('Content-Disposition', `attachment; filename="points_${new Date().toISOString().slice(0, 10)}.xlsx"`);
  res.send(buffer);
});

// ---- Admin : création / modification / suppression ----
router.post('/points', requireAuth, (req, res) => {
  const { ig, adresse, numero_batiment, secteur_nom, secteur_numero, x, y, lat, lng, commentaire } = req.body;

  let finalLat = lat;
  let finalLng = lng;
  let finalX = x;
  let finalY = y;

  if ((finalLat == null || finalLng == null) && x != null && y != null) {
    const conv = lambertToWGS84(x, y);
    finalLat = conv.lat;
    finalLng = conv.lng;
  } else if ((finalX == null || finalY == null) && lat != null && lng != null) {
    const conv = wgs84ToLambert(lat, lng);
    finalX = conv.x;
    finalY = conv.y;
  }

  const stmt = db.prepare(`
    INSERT INTO points (ig, adresse, numero_batiment, secteur_nom, secteur_numero, x, y, lat, lng, commentaire)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const info = stmt.run(
    ig || null,
    adresse || null,
    numero_batiment || null,
    secteur_nom || null,
    secteur_numero || null,
    finalX ?? null,
    finalY ?? null,
    finalLat ?? null,
    finalLng ?? null,
    commentaire || null
  );

  const created = db.prepare('SELECT * FROM points WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json(rowToPublic(created));
});

router.put('/points/:id', requireAuth, (req, res) => {
  const existing = db.prepare('SELECT * FROM points WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Point introuvable' });

  const { ig, adresse, numero_batiment, secteur_nom, secteur_numero, x, y, lat, lng, commentaire } = req.body;

  let finalLat = lat ?? existing.lat;
  let finalLng = lng ?? existing.lng;
  let finalX = x ?? existing.x;
  let finalY = y ?? existing.y;

  if (x != null && y != null && (x !== existing.x || y !== existing.y)) {
    const conv = lambertToWGS84(x, y);
    finalLat = conv.lat;
    finalLng = conv.lng;
  } else if (lat != null && lng != null && (lat !== existing.lat || lng !== existing.lng)) {
    const conv = wgs84ToLambert(lat, lng);
    finalX = conv.x;
    finalY = conv.y;
  }

  const stmt = db.prepare(`
    UPDATE points SET ig = ?, adresse = ?, numero_batiment = ?, secteur_nom = ?, secteur_numero = ?,
      x = ?, y = ?, lat = ?, lng = ?, commentaire = ?, date_modification = CURRENT_TIMESTAMP
    WHERE id = ?
  `);
  stmt.run(
    ig ?? existing.ig,
    adresse ?? existing.adresse,
    numero_batiment ?? existing.numero_batiment,
    secteur_nom ?? existing.secteur_nom,
    secteur_numero ?? existing.secteur_numero,
    finalX ?? null,
    finalY ?? null,
    finalLat ?? null,
    finalLng ?? null,
    commentaire ?? existing.commentaire,
    req.params.id
  );

  const updated = db.prepare('SELECT * FROM points WHERE id = ?').get(req.params.id);
  res.json(rowToPublic(updated));
});

router.delete('/points/:id', requireAuth, (req, res) => {
  const stmt = db.prepare('DELETE FROM points WHERE id = ?');
  const info = stmt.run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Point introuvable' });
  res.json({ success: true });
});

// ---- Suppression groupée ----
router.delete('/points', requireAuth, (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'Aucun identifiant fourni' });
  }
  const stmt = db.prepare('DELETE FROM points WHERE id = ?');
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

// ---- Import Excel en masse ----
router.post('/import', requireAuth, upload.single('file'), (req, res) => {
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
    INSERT INTO points (ig, adresse, numero_batiment, secteur_nom, secteur_numero, x, y, lat, lng)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      const ig = map['ig'] ?? map['numero ig'] ?? map['n ig'] ?? map['identifiant geographique'] ?? null;
      const adresse = map['adresse'] ?? map['address'] ?? null;
      const numeroBatiment = map['numero batiment'] ?? map['num batiment'] ?? map['n batiment']
        ?? map['numero de batiment'] ?? map['batiment'] ?? null;
      const secteurNom = map['secteur'] ?? map['nom secteur'] ?? map['nom du secteur'] ?? null;
      const secteurNumero = map['numero secteur'] ?? map['num secteur'] ?? map['n secteur']
        ?? map['numero du secteur'] ?? null;
      const x = map['x'] != null ? parseFloat(map['x']) : null;
      const y = map['y'] != null ? parseFloat(map['y']) : null;

      if (x == null || y == null || Number.isNaN(x) || Number.isNaN(y)) {
        errors++;
        continue;
      }

      const { lat, lng } = lambertToWGS84(x, y);
      insert.run(
        ig ? String(ig) : null,
        adresse ? String(adresse) : null,
        numeroBatiment != null ? String(numeroBatiment) : null,
        secteurNom != null ? String(secteurNom) : null,
        secteurNumero != null ? String(secteurNumero) : null,
        x, y, lat, lng
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

// ---- Import mise à jour (Excel) ----
router.post('/import-update', requireAuth, upload.single('file'), (req, res) => {
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
    INSERT INTO points (ig, adresse, numero_batiment, secteur_nom, secteur_numero, x, y, lat, lng)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET ig = excluded.ig, adresse = excluded.adresse,
      numero_batiment = excluded.numero_batiment, secteur_nom = excluded.secteur_nom,
      secteur_numero = excluded.secteur_numero, x = excluded.x, y = excluded.y,
      lat = excluded.lat, lng = excluded.lng, date_modification = CURRENT_TIMESTAMP
  `);

  let updated = 0;
  let errors = 0;
  db.exec('BEGIN');
  try {
    for (const row of rows) {
      const map = {};
      for (const key of Object.keys(row)) {
        map[normalizeKey(key)] = row[key];
      }
      const id = map['id'] != null ? parseInt(map['id']) : null;
      const ig = map['ig'] ?? map['numero ig'] ?? null;
      const adresse = map['adresse'] ?? map['address'] ?? null;
      const numeroBatiment = map['numero batiment'] ?? map['batiment'] ?? null;
      const secteurNom = map['secteur'] ?? map['nom secteur'] ?? null;
      const secteurNumero = map['numero secteur'] ?? map['n secteur'] ?? null;
      const x = map['x'] != null ? parseFloat(map['x']) : null;
      const y = map['y'] != null ? parseFloat(map['y']) : null;

      if (!id) { errors++; continue; }

      let finalLat, finalLng, finalX, finalY;
      if (x != null && y != null && !Number.isNaN(x) && !Number.isNaN(y)) {
        finalX = x;
        finalY = y;
        const conv = lambertToWGS84(x, y);
        finalLat = conv.lat;
        finalLng = conv.lng;
      } else {
        errors++;
        continue;
      }

      insert.run(
        ig ? String(ig) : null,
        adresse ? String(adresse) : null,
        numeroBatiment != null ? String(numeroBatiment) : null,
        secteurNom != null ? String(secteurNom) : null,
        secteurNumero != null ? String(secteurNumero) : null,
        finalX, finalY, finalLat, finalLng
      );
      updated++;
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    return res.status(500).json({ error: 'Erreur pendant la mise à jour: ' + e.message });
  }
  res.json({ updated, errors, total: rows.length });
});

// ---- Import SHP (points) ----
router.post('/import-shp', requireAuth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Aucun fichier reçu' });

  let AdmZip, shapefile;
  try {
    AdmZip = require('adm-zip');
    shapefile = require('shapefile');
  } catch (e) {
    return res.status(500).json({
      error: 'Dépendances manquantes pour l\'import SHP. Exécutez : npm install shapefile adm-zip',
    });
  }

  try {
    const zip = new AdmZip(req.file.buffer);
    const entries = zip.getEntries();
    const shpEntry = entries.find((e) => e.entryName.toLowerCase().endsWith('.shp'));
    const dbfEntry = entries.find((e) => e.entryName.toLowerCase().endsWith('.dbf'));

    if (!shpEntry) return res.status(400).json({ error: 'Le zip ne contient pas de fichier .shp' });

    const shpBuffer = shpEntry.getData();
    const dbfBuffer = dbfEntry ? dbfEntry.getData() : undefined;

    const source = await shapefile.open(shpBuffer, dbfBuffer);

    const insert = db.prepare(`
      INSERT INTO points (ig, adresse, numero_batiment, secteur_nom, secteur_numero, x, y, lat, lng)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        const coords = feature.geometry && feature.geometry.coordinates;
        if (!coords) { errors++; result = await source.read(); continue; }

        const [lng, lat] = coords;
        const props = feature.properties || {};
        const map = {};
        for (const key of Object.keys(props)) map[normalizeKey(key)] = props[key];

        const ig = map['ig'] ?? map['numero ig'] ?? map['n ig'] ?? null;
        const adresse = map['adresse'] ?? map['address'] ?? null;
        const numeroBatiment = map['numero batiment'] ?? map['batiment'] ?? map['n batiment'] ?? null;
        const secteurNom = map['secteur'] ?? map['nom secteur'] ?? null;
        const secteurNumero = map['numero secteur'] ?? map['num secteur'] ?? map['n secteur'] ?? null;

        const conv = wgs84ToLambert(lat, lng);
        insert.run(
          ig ? String(ig) : null,
          adresse ? String(adresse) : null,
          numeroBatiment != null ? String(numeroBatiment) : null,
          secteurNom != null ? String(secteurNom) : null,
          secteurNumero != null ? String(secteurNumero) : null,
          conv.x, conv.y, lat, lng
        );
        imported++;
        result = await source.read();
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      return res.status(500).json({ error: 'Erreur pendant l\'import SHP: ' + e.message });
    }
    res.json({ imported, errors, total });
  } catch (e) {
    res.status(400).json({ error: 'Fichier SHP illisible: ' + e.message });
  }
});

// ---- Import KML (points) ----
router.post('/import-kml', requireAuth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Aucun fichier reçu' });

  const xml = req.file.buffer.toString('utf8');
  const placemarkRegex = /<Placemark>([\s\S]*?)<\/Placemark>/gi;
  const placemarks = xml.match(placemarkRegex) || [];

  if (placemarks.length === 0) {
    return res.status(400).json({ error: 'Aucun point (Placemark) trouvé dans le fichier KML' });
  }

  const insert = db.prepare(`
    INSERT INTO points (ig, adresse, numero_batiment, secteur_nom, secteur_numero, x, y, lat, lng)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let imported = 0;
  let errors = 0;

  db.exec('BEGIN');
  try {
    for (const pm of placemarks) {
      const coordMatch = pm.match(/<coordinates>([\s\S]*?)<\/coordinates>/);
      if (!coordMatch) { errors++; continue; }

      const [lngStr, latStr] = coordMatch[1].trim().split(',');
      const lng = parseFloat(lngStr);
      const lat = parseFloat(latStr);
      if (Number.isNaN(lat) || Number.isNaN(lng)) { errors++; continue; }

      const nameMatch = pm.match(/<name>([\s\S]*?)<\/name>/);
      const ig = nameMatch ? nameMatch[1].trim() : null;

      const dataFields = {};
      const dataRegex = /<Data\s+name="([^"]+)">\s*<value>([\s\S]*?)<\/value>\s*<\/Data>/gi;
      let m;
      while ((m = dataRegex.exec(pm)) !== null) {
        dataFields[normalizeKey(m[1])] = m[2].trim();
      }

      const adresse = dataFields['adresse'] ?? dataFields['address'] ?? null;
      const numeroBatiment = dataFields['numero batiment'] ?? dataFields['batiment'] ?? null;
      const secteurNom = dataFields['secteur'] ?? dataFields['nom secteur'] ?? null;
      const secteurNumero = dataFields['numero secteur'] ?? dataFields['num secteur'] ?? null;

      const conv = wgs84ToLambert(lat, lng);
      insert.run(
        ig || null,
        adresse || null,
        numeroBatiment || null,
        secteurNom || null,
        secteurNumero || null,
        conv.x, conv.y, lat, lng
      );
      imported++;
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    return res.status(500).json({ error: 'Erreur pendant l\'import KML: ' + e.message });
  }
  res.json({ imported, errors, total: placemarks.length });
});

// ---- Preview import Excel ----
router.post('/import/preview', requireAuth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Aucun fichier reçu' });

  let workbook;
  try {
    workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
  } catch (e) {
    return res.status(400).json({ error: 'Fichier Excel illisible' });
  }

  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: null });

  const previewPoints = [];
  const errors = [];

  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const row = rows[i];
    const map = {};
    for (const key of Object.keys(row)) {
      map[normalizeKey(key)] = row[key];
    }
    const ig = map['ig'] ?? map['numero ig'] ?? null;
    const adresse = map['adresse'] ?? map['address'] ?? null;
    const x = map['x'] != null ? parseFloat(map['x']) : null;
    const y = map['y'] != null ? parseFloat(map['y']) : null;

    if (x != null && y != null && !Number.isNaN(x) && !Number.isNaN(y)) {
      const conv = lambertToWGS84(x, y);
      previewPoints.push({ ig, adresse, x, y, lat: conv.lat.toFixed(6), lng: conv.lng.toFixed(6) });
    } else {
      errors.push({ row: i + 1, reason: 'Coordonnées X/Y manquantes ou invalides' });
    }
  }

  res.json({ total: rows.length, preview: previewPoints, errors });
});

module.exports = router;