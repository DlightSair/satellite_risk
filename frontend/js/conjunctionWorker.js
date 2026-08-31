// Runs conjunction screening + risk scoring off the main thread, continuously,
// so SGP4 work across ~19k objects never drops render frames.
//
// MODULE worker (`{type:"module"}`, see satelliteDisplay.js) so this can
// `import` the exact same satellite.js version and conjunctionMath.js the
// rest of the app uses, instead of maintaining a separate copy. This used to
// be a classic worker pinned to satellite.js@4.1.3 (the last UMD build,
// since importScripts() needs a non-module script) for Firefox <114
// compatibility — but that pinned build silently returned NaN positions for
// at least one real satellite (a fresh Starlink TLE) that the current
// satellite.js version propagates fine, which meant this worker could report
// "no risk" for a pair the backend and the globe's own rendering both
// correctly flagged as critical. Module workers have been supported since
// Firefox 114 (2023), the same bar the rest of this app already assumes.
import {
  createSatrec,
  orbitalAltitudeBand,
  altitudeBandsCouldOverlap,
  findMinSeparation,
  riskForDistanceKm,
  CONJUNCTION_SCREEN_KM,
} from "../../shared/conjunctionMath.js";

// --- Worker orchestration --------------------------------------------------
//
// main -> worker: { type: "setTracked", noradIds: number[] }
// worker -> main:
//   { type: "catalogReady", objectCount, screenableCount }
//   { type: "result", noradId, name, generation, closeApproaches: [...] }
//   { type: "passComplete", generation }
//   { type: "error", context, message }

const SCREEN_WINDOW_MINUTES = 5 * 60;
const REFRESH_INTERVAL_MS = 60_000; // re-screen cadence as the window slides forward
const PREFILTER_MARGIN_KM = CONJUNCTION_SCREEN_KM; // tightest margin still provably safe
const YIELD_EVERY = 200; // pairs screened before yielding to the event loop

let catalog = []; // [{ noradId, name, type, satrec, band }]
let catalogReady = null;
let trackedIds = [];
let generation = 0; // bumped on every setTracked — invalidates stale in-flight results
let refreshTimer = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function reportError(context, error) {
  postMessage({ type: "error", context, message: String((error && error.stack) || error) });
}

async function loadCatalog() {
  const response = await fetch("../../data/raw/tle-latest.json");
  const data = await response.json();

  for (const object of data.objects) {
    const satrec = createSatrec(object.line1, object.line2);
    if (!satrec) continue;
    catalog.push({
      noradId: object.norad_id,
      name: object.name,
      type: object.type,
      satrec,
      band: orbitalAltitudeBand(satrec),
    });
  }

  postMessage({ type: "catalogReady", objectCount: data.objects.length, screenableCount: catalog.length });
}

async function screenOne(tracked, myGeneration) {
  const trackedEntry = catalog.find((entry) => entry.noradId === tracked);
  if (!trackedEntry) return;

  const fromDate = new Date();
  const closeApproaches = [];
  let sinceYield = 0;

  for (const other of catalog) {
    if (generation !== myGeneration) return; // superseded by a newer setTracked
    if (other.noradId === trackedEntry.noradId) continue;

    if (!altitudeBandsCouldOverlap(trackedEntry.band, other.band, PREFILTER_MARGIN_KM)) continue;

    const result = findMinSeparation(trackedEntry.satrec, other.satrec, fromDate, SCREEN_WINDOW_MINUTES);
    if (!result) continue;

    const risk = riskForDistanceKm(result.distanceKm);
    if (risk) {
      closeApproaches.push({
        noradId: other.noradId,
        name: other.name,
        type: other.type,
        distanceKm: result.distanceKm,
        atDate: result.atDate.toISOString(),
        risk,
      });
    }

    sinceYield++;
    if (sinceYield >= YIELD_EVERY) {
      sinceYield = 0;
      await sleep(0);
    }
  }

  if (generation !== myGeneration) return;

  closeApproaches.sort((a, b) => a.distanceKm - b.distanceKm);
  postMessage({
    type: "result",
    noradId: trackedEntry.noradId,
    name: trackedEntry.name,
    generation: myGeneration,
    closeApproaches,
  });
}

// myGeneration/idsThisPass are captured at call time, not re-read after
// awaiting catalogReady — two setTracked calls firing back-to-back before
// the catalog resolves would otherwise both wake up and re-read the same
// already-bumped state, making one of them redundant.
async function runPass(myGeneration, idsThisPass) {
  await catalogReady;

  for (const noradId of idsThisPass) {
    if (generation !== myGeneration) return;
    await screenOne(noradId, myGeneration);
  }

  if (generation === myGeneration) {
    postMessage({ type: "passComplete", generation: myGeneration });
  }
}

function runPassSafely(myGeneration, idsThisPass) {
  runPass(myGeneration, idsThisPass)
    .then(() => scheduleRefresh())
    .catch((error) => reportError("runPass", error));
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  if (trackedIds.length === 0) return; // nothing tracked — don't screen on a timer forever
  refreshTimer = setTimeout(() => {
    runPassSafely(generation, trackedIds);
  }, REFRESH_INTERVAL_MS);
}

onmessage = (event) => {
  const { type } = event.data;
  if (type !== "setTracked") return;

  generation++;
  trackedIds = event.data.noradIds;
  runPassSafely(generation, trackedIds);
};

catalogReady = loadCatalog().catch((error) => {
  reportError("loadCatalog", error);
  throw error; // keep catalogReady rejected so any pending runPass() short-circuits
});
