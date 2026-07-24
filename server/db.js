const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

// AlwysData: use writable DATA_DIR env or fallback to project root 'data' dir
const DB_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
if (!fs.existsSync(DB_DIR)) {
  try {
    fs.mkdirSync(DB_DIR, { recursive: true });
  } catch (e) {
    // Fallback: try /tmp if project dir is readonly (AlwysData deployment)
    const fallbackDir = path.join('/tmp', 'sigrys-data');
    if (!fs.existsSync(fallbackDir)) {
      fs.mkdirSync(fallbackDir, { recursive: true });
    }
    process.env.DATA_DIR = fallbackDir;
  }
}

const FINAL_DB_DIR = process.env.DATA_DIR || DB_DIR;
const DB_PATH = path.join(FINAL_DB_DIR, 'points.db');

// Ensure database file is writable
try {
  if (fs.existsSync(DB_PATH)) {
    fs.accessSync(DB_PATH, fs.constants.R_OK | fs.constants.W_OK);
  }
} catch (e) {
  console.error('⚠️  Database file not writable at ' + DB_PATH + ' — trying fallback...');
  const fallbackPath = path.join('/tmp', 'sigrys-data', 'points.db');
  process.env.DATA_DIR = path.join('/tmp', 'sigrys-data');
}

const FINAL_PATH = path.join(process.env.DATA_DIR || FINAL_DB_DIR, 'points.db');
const db = new DatabaseSync(FINAL_PATH);

// Enable WAL mode for better concurrent access
db.exec('PRAGMA journal_mode=WAL;');
db.exec('PRAGMA busy_timeout=5000;');

// Création de la table points si elle n'existe pas
db.exec(`
  CREATE TABLE IF NOT EXISTS points (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ig TEXT,
    adresse TEXT,
    x REAL,
    y REAL,
    lat REAL,
    lng REAL,
    commentaire TEXT,
    numero_batiment TEXT,
    secteur_nom TEXT,
    secteur_numero TEXT,
    date_creation TEXT DEFAULT CURRENT_TIMESTAMP,
    date_modification TEXT DEFAULT CURRENT_TIMESTAMP
  );
`);

// Index pour accélérer la recherche sur de gros volumes
db.exec(`CREATE INDEX IF NOT EXISTS idx_points_ig ON points(ig);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_points_adresse ON points(adresse);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_points_batiment ON points(numero_batiment);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_points_secteur ON points(secteur_numero);`);

// Table secteurs
db.exec(`
  CREATE TABLE IF NOT EXISTS sectors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    numero TEXT,
    nom TEXT,
    agence TEXT,
    color TEXT DEFAULT '#1e5f8a',
    geometry TEXT,
    date_creation TEXT DEFAULT CURRENT_TIMESTAMP,
    date_modification TEXT DEFAULT CURRENT_TIMESTAMP
  );
`);

db.exec(`CREATE INDEX IF NOT EXISTS idx_sectors_numero ON sectors(numero);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_sectors_nom ON sectors(nom);`);

console.log('✅ Database loaded from: ' + FINAL_PATH);

module.exports = db;
