const form = document.getElementById("converter-form");
const fileInput = document.getElementById("file");
const dropzone = document.getElementById("dropzone");
const fileList = document.getElementById("file-list");
const compressedSize = document.getElementById("compressed-size");
const capacityBar = document.getElementById("capacity-bar");
const submitButton = document.getElementById("submit-button");
const errorBox = document.getElementById("error");
const results = document.getElementById("results");
const mapPlaceholder = document.getElementById("map-placeholder");
const mapLegend = document.getElementById("map-legend");
const mapStatus = document.getElementById("map-status");
const processSubtitle = document.getElementById("process-subtitle");
const stages = Array.from(document.querySelectorAll("#process-steps > div"));

let map = null;
let surveyLayerGroup = null;
let baseTileLayer = null;
let tileErrorCount = 0;
let mapCanvasRenderer = null;
let stageTimer = null;

const surveyColors = ["#ffd21f", "#2cc970", "#ef5350", "#37a9ff", "#a978ff", "#ff8a34", "#20d2cf", "#f062b5"];

function show(element) { element.classList.remove("hidden"); }
function hide(element) { element.classList.add("hidden"); }
function formatNumber(value) { return new Intl.NumberFormat().format(value); }
function formatMb(bytes) { return `${(bytes / (1024 * 1024)).toFixed(1)} MB`; }

function renderFileList() {
  const files = Array.from(fileInput.files);
  const total = files.reduce((sum, file) => sum + file.size, 0);
  compressedSize.textContent = formatMb(total);
  capacityBar.style.width = `${Math.min(100, (total / (500 * 1024 * 1024)) * 100)}%`;
  capacityBar.classList.toggle("capacity-warning", total > 425 * 1024 * 1024);

  if (!files.length) {
    fileList.innerHTML = '<p class="empty-state">No files selected</p>';
    return;
  }

  fileList.innerHTML = files.map((file, index) => `
    <div class="file-row">
      <span class="file-status">✓</span>
      <div><strong>${escapeHtml(file.name)}</strong><small>${formatMb(file.size)}</small></div>
      <span class="file-number">${index + 1}</span>
    </div>
  `).join("");
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  })[character]);
}

fileInput.addEventListener("change", renderFileList);
["dragenter", "dragover"].forEach(name => dropzone.addEventListener(name, event => {
  event.preventDefault();
  dropzone.classList.add("dragover");
}));
["dragleave", "drop"].forEach(name => dropzone.addEventListener(name, event => {
  event.preventDefault();
  dropzone.classList.remove("dragover");
}));
dropzone.addEventListener("drop", event => {
  if (event.dataTransfer.files.length) {
    fileInput.files = event.dataTransfer.files;
    renderFileList();
  }
});

function resetStages() {
  clearInterval(stageTimer);
  stages.forEach(stage => {
    stage.classList.remove("active", "complete");
    stage.querySelector("small").textContent = "Waiting";
  });
}

function startStages() {
  resetStages();
  let current = 0;
  const labels = ["Uploading files", "Inspecting with MB-System", "Extracting soundings", "Building selected output", "Validating Olex rows", "Compressing final file"];
  const activate = () => {
    stages.forEach((stage, index) => {
      stage.classList.toggle("complete", index < current);
      stage.classList.toggle("active", index === current);
      stage.querySelector("small").textContent = index < current ? "Complete" : index === current ? "Processing" : "Waiting";
    });
    processSubtitle.textContent = labels[current] || "Finalizing";
    current = Math.min(current + 1, stages.length - 1);
  };
  activate();
  stageTimer = setInterval(activate, 3400);
}

function completeStages() {
  clearInterval(stageTimer);
  stages.forEach(stage => {
    stage.classList.remove("active");
    stage.classList.add("complete");
    stage.querySelector("small").textContent = "Complete";
  });
  processSubtitle.textContent = "Conversion and output validation complete";
}

function ensureMap() {
  if (map) return;

  map = L.map("map", {
    zoomControl: true,
    preferCanvas: true,
    zoomSnap: 0.25,
    zoomDelta: 0.5,
    worldCopyJump: false
  });

  mapCanvasRenderer = L.canvas({ padding: 0.6 });

  baseTileLayer = L.tileLayer(
    "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    {
      maxZoom: 19,
      maxNativeZoom: 19,
      noWrap: true,
      updateWhenIdle: true,
      keepBuffer: 6,
      crossOrigin: true,
      attribution: "&copy; OpenStreetMap contributors"
    }
  );

  baseTileLayer.on("tileerror", () => {
    tileErrorCount += 1;

    // A few failed requests can happen on slow connections. If several tiles
    // fail, remove the broken checkerboard and keep the sounding overlay on a
    // clean ocean background. Conversion data is unaffected.
    if (tileErrorCount >= 6 && map.hasLayer(baseTileLayer)) {
      map.removeLayer(baseTileLayer);
      document.getElementById("map-note").textContent =
        "Basemap tiles could not be loaded reliably. The colored sounding tracks " +
        "are still plotted from the converted survey coordinates.";
      mapStatus.textContent = "Sounding map · basemap unavailable";
      document.getElementById("map").classList.add("basemap-fallback");
    }
  });

  baseTileLayer.addTo(map);
  surveyLayerGroup = L.layerGroup().addTo(map);
  L.control.scale({ imperial: false, position: "bottomleft" }).addTo(map);
}

function quantile(sortedValues, fraction) {
  if (!sortedValues.length) return null;
  const position = (sortedValues.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sortedValues[lower];
  const weight = position - lower;
  return sortedValues[lower] * (1 - weight) + sortedValues[upper] * weight;
}

function calculateRobustBounds(points) {
  if (!points.length) return null;

  const latitudes = points.map(point => point[0]).sort((a, b) => a - b);
  const longitudes = points.map(point => point[1]).sort((a, b) => a - b);

  // Ignore only the most extreme 0.5% at each edge when enough samples exist.
  // This prevents a corrupt isolated position from zooming the real survey
  // tracks down to a tiny dot.
  const trim = points.length >= 200 ? 0.005 : 0;
  const south = quantile(latitudes, trim);
  const north = quantile(latitudes, 1 - trim);
  const west = quantile(longitudes, trim);
  const east = quantile(longitudes, 1 - trim);

  if (![south, north, west, east].every(Number.isFinite)) return null;
  if (south === north && west === east) return L.latLngBounds([[south, west], [north, east]]);

  return L.latLngBounds([[south, west], [north, east]]);
}

function renderSurveyMap(surveys) {
  ensureMap();
  surveyLayerGroup.clearLayers();
  mapLegend.innerHTML = "";
  tileErrorCount = 0;

  const validMapPoints = [];

  surveys.forEach((survey, index) => {
    const color = surveyColors[index % surveyColors.length];
    const layer = L.layerGroup();

    survey.points.forEach(point => {
      const [lat, lon, depth] = point;
      if (
        !Number.isFinite(lat) ||
        !Number.isFinite(lon) ||
        !Number.isFinite(depth) ||
        lat < -90 || lat > 90 ||
        lon < -180 || lon > 180 ||
        depth <= 0
      ) {
        return;
      }

      validMapPoints.push([lat, lon]);

      L.circleMarker([lat, lon], {
        radius: 3.2,
        weight: 0.7,
        color,
        opacity: 0.9,
        fillColor: color,
        fillOpacity: 0.82,
        renderer: mapCanvasRenderer
      }).bindTooltip(
        `<strong>${escapeHtml(survey.filename)}</strong><br>` +
        `Depth: ${depth.toFixed(1)} m<br>` +
        `${lat.toFixed(6)}, ${lon.toFixed(6)}`
      ).addTo(layer);
    });

    layer.addTo(surveyLayerGroup);

    mapLegend.insertAdjacentHTML("beforeend", `
      <div class="legend-row">
        <span style="background:${color}"></span>
        <div>
          <strong>${escapeHtml(survey.filename)}</strong>
          <small>${formatNumber(survey.sounding_count)} soundings · ` +
          `${survey.depth_range_m.minimum.toFixed(1)}–${survey.depth_range_m.maximum.toFixed(1)} m</small>
        </div>
      </div>
    `);
  });

  hide(mapPlaceholder);
  show(mapLegend);
  mapStatus.textContent =
    `${surveys.length} sonar file${surveys.length === 1 ? "" : "s"} mapped`;
  mapStatus.classList.add("status-pill--ready");

  const robustBounds = calculateRobustBounds(validMapPoints);

  // Leaflet can calculate an incorrect tile layout if the dashboard changes
  // size immediately before the map becomes visible. Recalculate first, fit
  // the survey, then recalculate once more after the browser has painted it.
  map.invalidateSize({ pan: false });

  if (robustBounds && robustBounds.isValid()) {
    map.fitBounds(robustBounds, {
      padding: [34, 34],
      maxZoom: 14,
      animate: false
    });
  } else if (validMapPoints.length === 1) {
    map.setView(validMapPoints[0], 12, { animate: false });
  } else {
    map.setView([0, 0], 2, { animate: false });
  }

  window.setTimeout(() => map.invalidateSize({ pan: false }), 120);
  window.setTimeout(() => map.invalidateSize({ pan: false }), 600);
}

function renderSurveyTable(surveys) {
  const table = document.getElementById("survey-table");
  table.innerHTML = `
    <div class="survey-table__head"><span>Source file</span><span>Soundings</span><span>Depth range</span><span>WGS 84 bounds</span></div>
    ${surveys.map((survey, index) => {
      const color = surveyColors[index % surveyColors.length];
      const b = survey.bounds;
      return `
        <div class="survey-table__row">
          <span><i style="background:${color}"></i><strong>${escapeHtml(survey.filename)}</strong></span>
          <span>${formatNumber(survey.sounding_count)}</span>
          <span>${survey.depth_range_m.minimum.toFixed(1)}–${survey.depth_range_m.maximum.toFixed(1)} m</span>
          <span>${b.south.toFixed(5)}° to ${b.north.toFixed(5)}°<br>${b.west.toFixed(5)}° to ${b.east.toFixed(5)}°</span>
        </div>
      `;
    }).join("")}
  `;
}

form.addEventListener("submit", async event => {
  event.preventDefault();
  hide(errorBox);
  hide(results);

  if (!fileInput.files.length) {
    errorBox.textContent = "Select one or more supported multibeam files.";
    show(errorBox);
    return;
  }

  const data = new FormData(form);
  data.set("acknowledgement", document.getElementById("acknowledgement").checked ? "true" : "false");

  submitButton.disabled = true;
  submitButton.textContent = "Processing bathymetry…";
  startStages();

  try {
    const response = await fetch("/api/convert", { method: "POST", body: data });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.detail || "The conversion failed.");

    completeStages();
    renderSurveyMap(payload.surveys);
    renderSurveyTable(payload.surveys);

    document.getElementById("output-name").textContent = payload.output_filename;
    document.getElementById("download-link").href = payload.download_url;
    document.getElementById("report-link").href = payload.report_url;
    document.getElementById("source-files").textContent = formatNumber(payload.summary.source_file_count);
    document.getElementById("input-points").textContent = formatNumber(payload.summary.accepted_input_points);
    document.getElementById("grid-cells").textContent = formatNumber(payload.summary.output_grid_cells);
    document.getElementById("depth-range").textContent =
      `${payload.summary.output_depth_range_m.minimum.toFixed(1)}–${payload.summary.output_depth_range_m.maximum.toFixed(1)} m`;
    document.getElementById("method-result").textContent = payload.summary.output_mode_label;
    document.getElementById("checksum").textContent = payload.summary.output_sha256;

    show(results);
    results.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    resetStages();
    processSubtitle.textContent = "Conversion stopped";
    errorBox.textContent = error.message;
    show(errorBox);
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = "Convert & validate Olex file";
  }
});

renderFileList();
