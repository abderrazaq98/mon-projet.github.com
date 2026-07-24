const path = require('path');

// Charger .env depuis la racine du projet OU depuis server/
require('dotenv').config({ path: path.resolve(process.cwd(), '.env') });
require('dotenv').config({ path: path.join(__dirname, '.env') });

const express = require('express');
const session = require('express-session');
const cors = require('cors');
const pointsRouter = require('./routes/points');
const sectorsRouter = require('./routes/sectors');

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || process.env.IP || '0.0.0.0';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const MAP_PASSWORD = process.env.MAP_PASSWORD;
const SESSION_SECRET = process.env.SESSION_SECRET || 'session-secret-' + Math.random().toString(36);

// Vérification des mots de passe configurés
if (!ADMIN_PASSWORD) {
  console.warn('⚠️  ADMIN_PASSWORD non défini dans l\'environnement. Utilisez la valeur par défaut.');
}
if (!MAP_PASSWORD) {
  console.warn('⚠️  MAP_PASSWORD non défini dans l\'environnement. Utilisez la valeur par défaut.');
}

const ADMIN_PASS = ADMIN_PASSWORD || 'changez-ce-mot-de-passe1';
const MAP_PASS = MAP_PASSWORD || 'changez-ce-mot-de-passe1';

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 1000 * 60 * 60 * 8, // 8h
    httpOnly: true,
  },
}));

// ---- Map auth (cookie-based, like the Next.js version) ----
app.get('/api/map-auth', (req, res) => {
  res.json({ isMapAuth: req.session.isMapAuth === true });
});

app.post('/api/map-auth', (req, res) => {
  const { password } = req.body;
  if (password === MAP_PASS) {
    req.session.isMapAuth = true;
    return res.json({ success: true });
  }
  res.status(401).json({ error: 'Mot de passe incorrect' });
});

app.delete('/api/map-auth', (req, res) => {
  req.session.isMapAuth = false;
  res.json({ success: true });
});

// ---- Auth admin ----
app.post('/api/login', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASS) {
    req.session.isAdmin = true;
    return res.json({ success: true });
  }
  res.status(401).json({ error: 'Mot de passe incorrect' });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

app.get('/api/session', (req, res) => {
  res.json({ isAdmin: !!(req.session && req.session.isAdmin) });
});

// ---- API points ----
app.use('/api', pointsRouter);

// ---- API secteurs ----
app.use('/api', sectorsRouter);

// ---- Fichiers statiques (frontend) ----
app.use(express.static(path.join(__dirname, '..', 'public')));

app.listen(PORT, HOST, () => {
  console.log('═══════════════════════════════════════════════');
  console.log('  Serveur sites d\'intervention démarré');
  console.log('  URL carte  : http://' + HOST + ':' + PORT + '/');
  console.log('  URL admin  : http://' + HOST + ':' + PORT + '/admin.html');
  console.log('  Mot de passe carte  : ' + (process.env.MAP_PASSWORD ? '✓ configuré (env)' : '⚠ valeur par défaut'));
  console.log('  Mot de passe admin  : ' + (process.env.ADMIN_PASSWORD ? '✓ configuré (env)' : '⚠ valeur par défaut'));
  console.log('  Zone Lambert         : ' + (process.env.LAMBERT_ZONE || 'LAMBERT_NORD'));
  console.log('═══════════════════════════════════════════════');
});