// ==================== AUTH ====================
async function checkMapAuth() {
  try {
    const res = await fetch('/api/map-auth');
    const data = await res.json();
    if (data.isMapAuth) {
      showMapView();
    } else {
      showLoginView();
    }
  } catch (e) {
    showLoginView();
  }
}

function showLoginView() {
  document.getElementById('loginView').classList.remove('hidden');
  document.getElementById('mapView').classList.add('hidden');
}

function showMapView() {
  document.getElementById('loginView').classList.add('hidden');
  document.getElementById('mapView').classList.remove('hidden');
  initMap();
}

document.getElementById('loginBtn').addEventListener('click', async () => {
  const password = document.getElementById('passwordInput').value;
  const errEl = document.getElementById('loginError');
  errEl.textContent = '';
  try {
    const res = await fetch('/api/map-auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    if (res.ok) {
      showMapView();
    } else {
      const data = await res.json();
      errEl.textContent = data.error || 'Mot de passe incorrect';
    }
  } catch {
    errEl.textContent = 'Erreur de connexion';
  }
});

document.getElementById('passwordInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('loginBtn').click();
});

document.getElementById('logoutBtn').addEventListener('click', async () => {
  await fetch('/api/map-auth', { method: 'DELETE' });
  // Clean up map
  if (window._map) { window._map.remove(); window._map = null; }
  document.getElementById('passwordInput').value = '';
  showLoginView();
});

// ==================== MAP ====================
let map, osmLayer, satLayer, markersLayer, sectorsLayer;
let allMarkers = new Map();
let allPoints = [];
let sectorsData = [];
let satellite = false;
let selectedMarker = null;
let selectedSectorHighlight = null;

function initMap() {
  if (map) return;

  map = L.map('map', { center: [35.5785, -5.3684], zoom: 9, zoomControl: true });

  osmLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors',
    maxZoom: 19,
  });

  satLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    attribution: '&copy; Esri',
    maxZoom: 19,
  });

  osmLayer.addTo(map);
  markersLayer = L.layerGroup().addTo(map);
  sectorsLayer = L.layerGroup().addTo(map);

  // Legend
  const legend = L.control({ position: 'bottomright' });
  legend.onAdd = function () {
    const div = L.DomUtil.create('div', 'map-legend');
    div.innerHTML = '<div class="legend-item"><span class="legend-dot"></span>Identifiant géographique</div>';
    div.id = 'legendContainer';
    return div;
  };
  legend.addTo(map);

  // Click on map to deselect
  map.on('click', (e) => {
    // Check if clicked inside a sector polygon
    if (sectorsData.length > 0) {
      let foundSector = false;
      sectorsLayer.eachLayer((layer) => {
        if (foundSector) return;
        if (layer instanceof L.Path && layer.containsPoint(e.layerPoint)) {
          const fid = layer.feature?.properties?.sectorId;
          if (fid != null) {
            selectSector(fid);
            foundSector = true;
          }
        }
      });
      if (foundSector) return;
    }
    clearSelection();
  });

  // Load data
  loadPoints();
  loadSectors();

  // Hide loading
  document.getElementById('loadingOverlay').classList.add('hidden');
}

// ---- Satellite toggle ----
document.getElementById('satelliteBtn').addEventListener('click', () => {
  if (!map) return;
  satellite = !satellite;
  const btn = document.getElementById('satelliteBtn');
  if (satellite) {
    osmLayer.remove();
    satLayer.addTo(map);
    btn.classList.add('active');
    btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/><path d="M19 3l-7 7"/></svg><span>Plan</span>';
  } else {
    satLayer.remove();
    osmLayer.addTo(map);
    btn.classList.remove('active');
    btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg><span>Satellite</span>';
  }
});

// ==================== Points ====================
function clearMarkers() {
  markersLayer.clearLayers();
  allMarkers.clear();
}

function addPointMarker(p) {
  if (p.lat == null || p.lng == null) return null;
  const cm = L.circleMarker([p.lat, p.lng], {
    radius: 7,
    fillColor: '#0d9488',
    color: '#fff',
    weight: 2,
    fillOpacity: 0.9,
  });
  cm.bindTooltip(p.ig || 'Sans IG', { direction: 'top', offset: [0, -8], className: 'point-tooltip' });
  cm.on('click', (e) => {
    L.DomEvent.stopPropagation(e);
    selectPoint(p);
  });
  markersLayer.addLayer(cm);
  allMarkers.set(p.id, cm);
  return cm;
}

async function loadPoints() {
  try {
    const res = await fetch('/api/points?limit=2000');
    allPoints = await res.json();
    clearMarkers();
    allPoints.forEach(addPointMarker);
  } catch (e) {
    console.error('Erreur chargement points:', e);
  }
}

// ==================== Sectors ====================
async function loadSectors() {
  try {
    const res = await fetch('/api/sectors');
    sectorsData = await res.json();
    sectorsLayer.clearLayers();
    const withGeom = sectorsData.filter((s) => s.geometry);
    if (withGeom.length > 0) {
      const features = withGeom.map((s) => {
        let geom;
        try { geom = typeof s.geometry === 'string' ? JSON.parse(s.geometry) : s.geometry; } catch { return null; }
        return { type: 'Feature', properties: { nom: s.nom, numero: s.numero, sectorId: s.id }, geometry: geom };
      }).filter(Boolean);
      const geojson = { type: 'FeatureCollection', features };
      L.geoJSON(geojson, {
        style: () => ({ color: '#ef4444', weight: 2, opacity: 0.8, fillColor: '#ef4444', fillOpacity: 0, interactive: false }),
        onEachFeature: (feature, layer) => {
          const label = feature.properties?.numero || feature.properties?.nom;
          if (label) layer.bindTooltip(label, { permanent: true, direction: 'center', className: 'sector-label' });
        },
      }).addTo(sectorsLayer);
      // Update legend
      const lc = document.getElementById('legendContainer');
      if (lc) {
        lc.innerHTML = '<div class="legend-item"><span class="legend-dot"></span>Identifiant géographique</div><div class="legend-separator"></div><div class="legend-item"><span class="legend-sector"></span>Secteurs</div>';
      }
    }
  } catch (e) {
    console.error('Erreur chargement secteurs:', e);
  }
}

// ==================== Selection ====================
function clearSelectionHighlight() {
  if (selectedMarker) {
    selectedMarker.setStyle({ color: '#fff', weight: 2, radius: 7, fillColor: '#0d9488', fillOpacity: 0.9 });
    selectedMarker = null;
  }
  if (selectedSectorHighlight) {
    map.removeLayer(selectedSectorHighlight);
    selectedSectorHighlight = null;
    // Restore sector styles
    sectorsLayer.eachLayer((layer) => {
      if (layer instanceof L.Path) {
        layer.setStyle({ color: '#ef4444', weight: 2, opacity: 0.8, fillColor: '#ef4444', fillOpacity: 0 });
      }
    });
  }
}

function clearSelection() {
  clearSelectionHighlight();
  document.getElementById('detailPanel').classList.add('hidden');
}

function selectPoint(p) {
  clearSelectionHighlight();
  const marker = allMarkers.get(p.id);
  if (marker) {
    marker.setStyle({ color: '#0f766e', weight: 3, radius: 9, fillColor: '#14b8a6', fillOpacity: 1 });
    selectedMarker = marker;
  }
  if (p.lat != null && p.lng != null) {
    map.flyTo([p.lat, p.lng], 17, { duration: 0.6 });
  }

  // Show detail panel
  const panel = document.getElementById('detailPanel');
  const title = document.getElementById('detailTitle');
  const content = document.getElementById('detailContent');
  title.innerHTML = '<span class="detail-icon-point">📍</span> Détail du point';

  let html = '<div class="detail-body">';
  if (p.ig) html += detailRow('IG', p.ig);
  if (p.adresse) html += detailRow('Adresse', p.adresse);
  if (p.numero_batiment) html += detailRow('N° Bâtiment', p.numero_batiment);
  if (p.secteur_nom) html += detailRow('Secteur', p.secteur_nom);
  if (p.secteur_numero) html += detailRow('N° Secteur', p.secteur_numero);
  html += '<div class="detail-separator"></div>';
  html += '<div class="detail-coords">';
  html += '<div class="detail-coord-label">Coordonnées</div>';
  if (p.lat != null && p.lng != null) {
    html += '<div class="detail-coord-value">' + p.lat.toFixed(6) + ', ' + p.lng.toFixed(6) + '</div>';
    if (p.x != null && p.y != null) {
      html += '<div class="detail-coord-lambert">Lambert: ' + p.x.toFixed(1) + ', ' + p.y.toFixed(1) + '</div>';
    }
  }
  html += '</div>';
  if (p.commentaire) html += detailRow('Commentaire', p.commentaire);
  if (p.lat != null && p.lng != null) {
    const gmapsLink = 'https://www.google.com/maps?q=' + p.lat + ',' + p.lng;
    html += '<div class="detail-actions">';
    html += '<a href="' + gmapsLink + '" target="_blank" class="btn btn-secondary btn-sm">Google Maps ↗</a>';
    html += '<button class="btn btn-secondary btn-sm" onclick="navigator.clipboard.writeText(\'' + gmapsLink + '\').then(()=>{this.textContent=\'Copié !\';setTimeout(()=>{this.textContent=\'Copier\';},1500)})">Copier</button>';
    html += '</div>';
  }
  html += '</div>';
  content.innerHTML = html;
  panel.classList.remove('hidden');
}

function selectSector(sectorId) {
  clearSelectionHighlight();
  const sector = sectorsData.find((s) => s.id === sectorId);
  if (!sector || !sector.geometry) return;

  let geom;
  try { geom = typeof sector.geometry === 'string' ? JSON.parse(sector.geometry) : sector.geometry; } catch { return; }
  const feature = { type: 'Feature', properties: {}, geometry: geom };
  selectedSectorHighlight = L.geoJSON(feature, {
    style: { color: '#dc2626', weight: 3, opacity: 1, fillColor: '#dc2626', fillOpacity: 0.15 },
  }).addTo(map);

  // Dim other sectors
  sectorsLayer.eachLayer((layer) => {
    if (layer instanceof L.Path) {
      layer.setStyle({ color: '#ef4444', weight: 1, opacity: 0.3, fillColor: '#ef4444', fillOpacity: 0 });
    }
  });

  if (selectedSectorHighlight) {
    map.fitBounds(selectedSectorHighlight.getBounds(), { padding: [40, 40], maxZoom: 16 });
  }

  // Find points in sector
  const sectorPoints = allPoints.filter((p) =>
    (sector.nom && p.secteur_nom === sector.nom) ||
    (sector.numero && p.secteur_numero === sector.numero)
  );

  const panel = document.getElementById('detailPanel');
  const title = document.getElementById('detailTitle');
  const content = document.getElementById('detailContent');
  title.innerHTML = '<span class="detail-icon-sector">🔷</span> Détail du secteur';

  let html = '<div class="detail-body">';
  if (sector.nom) html += detailRow('Nom', sector.nom);
  if (sector.numero) html += detailRow('Numéro', sector.numero);
  if (sector.agence) html += detailRow('Agence', sector.agence);
  html += '<div class="detail-separator"></div>';
  html += '<div class="detail-sector-points-count">📍 ' + sectorPoints.length + ' point(s) dans ce secteur</div>';
  if (sectorPoints.length > 0) {
    html += '<div class="detail-sector-points">';
    sectorPoints.forEach((p) => {
      html += '<div class="detail-sector-point" onclick="selectPointById(' + p.id + ')">';
      html += '<div class="detail-sector-point-name">' + (p.ig || 'Sans IG') + '</div>';
      if (p.adresse) html += '<div class="detail-sector-point-addr">' + p.adresse + '</div>';
      html += '</div>';
    });
    html += '</div>';
  }
  html += '</div>';
  content.innerHTML = html;
  panel.classList.remove('hidden');
}

// Global function for inline onclick
window.selectPointById = function (id) {
  const p = allPoints.find((pt) => pt.id === id);
  if (p) selectPoint(p);
};

function detailRow(label, value) {
  return '<div class="detail-row"><span class="detail-label">' + label + '</span><span class="detail-value">' + value + '</span></div>';
}

document.getElementById('closeDetail').addEventListener('click', clearSelection);

// ==================== Search ====================
async function performSearch() {
  const type = document.getElementById('searchType').value;
  const q = document.getElementById('searchInput').value.trim();
  const status = document.getElementById('searchStatus');
  const clearBtn = document.getElementById('clearSearchBtn');

  if (!q) {
    closeResults();
    return;
  }

  status.textContent = 'Recherche...';

  // Sector search (local)
  if (type === 'secteur_numero' || type === 'secteur_nom') {
    const ql = q.toLowerCase();
    const results = sectorsData.filter((s) => {
      if (type === 'secteur_numero') return (s.numero || '').toLowerCase().includes(ql);
      return (s.nom || '').toLowerCase().includes(ql);
    });
    renderSectorResults(results);
    status.textContent = '';
    clearBtn.style.display = '';
    return;
  }

  // Point search (API)
  try {
    const params = new URLSearchParams();
    params.set('q', q);
    if (type) params.set('type', type);
    params.set('limit', '1000');
    const res = await fetch('/api/points?' + params.toString());
    if (!res.ok) {
      const err = await res.json();
      status.textContent = err.error || 'Erreur';
      return;
    }
    const points = await res.json();
    status.textContent = '';
    clearMarkers();
    points.forEach(addPointMarker);
    renderPointResults(points);
    clearBtn.style.display = '';

    if (points.length === 1 && points[0].lat != null) {
      map.flyTo([points[0].lat, points[0].lng], 17);
      allMarkers.get(points[0].id)?.openPopup();
    } else if (points.length > 1) {
      const group = L.featureGroup([...allMarkers.values()]);
      if (group.getLayers().length) map.fitBounds(group.getBounds().pad(0.2));
    }
  } catch (e) {
    status.textContent = 'Erreur réseau';
  }
}

function renderPointResults(points) {
  const panel = document.getElementById('resultsPanel');
  const list = document.getElementById('resultsList');
  const count = document.getElementById('resultsCount');
  count.textContent = points.length + ' résultat(s)';
  list.innerHTML = '';
  if (points.length === 0) {
    list.innerHTML = '<div class="no-results">Aucun point trouvé.</div>';
  }
  points.forEach((p) => {
    const div = document.createElement('div');
    div.className = 'result-item';
    const gmapsLink = (p.lat != null && p.lng != null) ? 'https://www.google.com/maps?q=' + p.lat + ',' + p.lng : '';
    div.innerHTML = '<div class="result-ig">' + (p.ig || 'Sans IG') + '</div>' +
      '<div class="result-adresse">' + (p.adresse || 'Adresse inconnue') + '</div>' +
      (p.numero_batiment ? '<div class="result-bat">Bât. ' + p.numero_batiment + '</div>' : '') +
      (gmapsLink ? '<button class="copy-gmaps-btn">Copier le lien</button>' : '');
    div.addEventListener('click', (e) => {
      if (e.target.classList.contains('copy-gmaps-btn')) return;
      selectPoint(p);
    });
    const copyBtn = div.querySelector('.copy-gmaps-btn');
    if (copyBtn) {
      copyBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        navigator.clipboard?.writeText(gmapsLink).then(() => {
          copyBtn.textContent = 'Copié !';
          setTimeout(() => { copyBtn.textContent = 'Copier le lien'; }, 1500);
        });
      });
    }
    list.appendChild(div);
  });
  panel.classList.remove('hidden');
}

function renderSectorResults(sectors) {
  const panel = document.getElementById('resultsPanel');
  const list = document.getElementById('resultsList');
  const count = document.getElementById('resultsCount');
  count.textContent = sectors.length + ' secteur(s)';
  list.innerHTML = '';
  if (sectors.length === 0) {
    list.innerHTML = '<div class="no-results">Aucun secteur trouvé.</div>';
  }
  sectors.forEach((s) => {
    const div = document.createElement('div');
    div.className = 'result-item';
    div.innerHTML = '<div class="result-ig"><span class="result-sector-icon">🔷</span> ' + (s.numero || s.nom || 'Secteur #' + s.id) + '</div>' +
      ((s.numero && s.nom) ? '<div class="result-adresse">' + s.nom + '</div>' : '') +
      (s.agence ? '<div class="result-bat">' + s.agence + '</div>' : '');
    div.addEventListener('click', () => {
      selectSector(s.id);
      closeResults();
    });
    list.appendChild(div);
  });
  panel.classList.remove('hidden');
}

function closeResults() {
  document.getElementById('resultsPanel').classList.add('hidden');
  document.getElementById('searchStatus').textContent = '';
  document.getElementById('clearSearchBtn').style.display = 'none';
  // Reload all points
  clearMarkers();
  allPoints.forEach(addPointMarker);
}

document.getElementById('searchBtn').addEventListener('click', performSearch);
document.getElementById('searchInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') performSearch();
});
document.getElementById('closeResults').addEventListener('click', closeResults);
document.getElementById('clearSearchBtn').addEventListener('click', closeResults);

// ==================== Init ====================
checkMapAuth();
