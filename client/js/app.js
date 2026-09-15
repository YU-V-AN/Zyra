import { db, auth, storage, functions } from "./firebase-config.js";
import {
  collection,
  addDoc,
  onSnapshot,
  doc,
  updateDoc,
  getDoc,
  setDoc,
  query,
  where,
  orderBy,
  arrayUnion,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signInAnonymously,
  signOut,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import {
  ref,
  uploadBytes,
  getDownloadURL
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-storage.js";
import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-functions.js";
import { translations, t, applyTranslations } from "./translations.js";

// =========================================================
// 1. STATE VARIABLES & CONFIGURATION
// =========================================================
let currentUser = null;      // set only for a logged-in (non-anonymous) recycler
let collectorUid = null;     // this device's anonymous collector identity
let isSignUpMode = false;
let activeTab = "collector";
let currentFilter = "all";
let currentLang = "en";
let cachedRequests = [];     // full feed, populated only for authenticated recyclers
let myRequests = [];         // this collector's own requests only

let unsubCollector = null;
let unsubRecycler = null;

// Recycler Processing Center Default Coordinates
const RECYCLER_LAT = 13.082680;
const RECYCLER_LNG = 80.270718;

// Fallback price list (₹ per kg) used until Firestore's config/rateCard
// document loads. Edit that document in the Firestore console to change
// prices without redeploying — see SETUP.md.
const DEFAULT_RATE_CARD = {
  "Printed Circuit Boards (PCBs)": 250,
  "Copper Cables & Wires": 480,
  "Batteries (Li-ion/Lead Acid)": 90,
  "Display Screens / CRTs": 60,
  "Mixed Electronic Scrap": 35
};
let rateCard = { ...DEFAULT_RATE_CARD };

const STATUS_STEPS = ["Requested", "Accepted", "Completed"];

const CATEGORY_I18N_KEY = {
  "Printed Circuit Boards (PCBs)": "cat.pcb",
  "Copper Cables & Wires": "cat.copper",
  "Batteries (Li-ion/Lead Acid)": "cat.battery",
  "Display Screens / CRTs": "cat.display",
  "Mixed Electronic Scrap": "cat.mixed"
};

// =========================================================
// 2. HELPER FUNCTIONS
// =========================================================

function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return (R * c).toFixed(2);
}

function categoryLabel(type) {
  const key = CATEGORY_I18N_KEY[type];
  return key ? t(currentLang, key) : type;
}

function debounce(fn, waitMs) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), waitMs);
  };
}

// Turns a Nominatim result (search or reverse) into a short "locality, city"
// label used to group requests for the area leaderboard.
function extractAreaLabel(nominatimResult) {
  const addr = nominatimResult.address || {};
  const locality = addr.suburb || addr.neighbourhood || addr.village || addr.town || addr.city_district || "";
  const city = addr.city || addr.town || addr.county || "";
  const label = [locality, city].filter(Boolean).join(", ");
  if (label) return label;
  return (nominatimResult.display_name || "").split(",").slice(0, 2).join(",").trim() || "Unspecified Area";
}

async function reverseGeocodeArea(lat, lng) {
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&addressdetails=1&lat=${lat}&lon=${lng}`);
    const data = await res.json();
    return extractAreaLabel(data);
  } catch (err) {
    console.warn("Reverse geocode failed, using placeholder area label:", err);
    return "Unspecified Area";
  }
}
// Note: for real production traffic, proxy geocoding through your own
// backend rather than calling Nominatim directly from every browser —
// their public instance has a strict fair-use rate limit.
const debouncedReverseGeocode = debounce(async (lat, lng) => {
  selectedAreaLabel = await reverseGeocodeArea(lat, lng);
  renderLocationStatus();
}, 700);

function buildProgressTrackHTML(status) {
  const idx = Math.max(STATUS_STEPS.indexOf(status), 0);
  const steps = STATUS_STEPS.map((s, i) => {
    const cls = i < idx ? "is-done" : (i === idx ? "is-current" : "");
    return `<span class="progress-step ${cls}"></span>`;
  }).join("");
  const labels = STATUS_STEPS.map(s => `<span>${t(currentLang, "status." + s.toLowerCase())}</span>`).join("");
  const trackLabel = `${t(currentLang, "collector.trackTitle")}: ${t(currentLang, "status." + status.toLowerCase())}`;
  return `<div class="progress-track" role="img" aria-label="${trackLabel}">${steps}</div><div class="progress-labels">${labels}</div>`;
}

function statusBadge(status) {
  return `<span class="badge ${status.toLowerCase()}">${t(currentLang, "status." + status.toLowerCase())}</span>`;
}

const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const statCache = {};
function animateStat(id, targetValue, decimals = 0, prefix = "") {
  const el = document.getElementById(id);
  if (!el) return;
  const start = statCache[id] ?? 0;
  statCache[id] = targetValue;

  if (prefersReducedMotion) {
    el.textContent = prefix + targetValue.toFixed(decimals);
    return;
  }

  const duration = 500;
  const startTime = performance.now();
  function tick(now) {
    const progress = Math.min((now - startTime) / duration, 1);
    const value = start + (targetValue - start) * progress;
    el.textContent = prefix + value.toFixed(decimals);
    if (progress < 1) requestAnimationFrame(tick);
    else el.textContent = prefix + targetValue.toFixed(decimals);
  }
  requestAnimationFrame(tick);
}

// =========================================================
// 3. LANGUAGE SWITCHING
// =========================================================
const languageSelect = document.getElementById("languageSelect");
languageSelect.addEventListener("change", (e) => {
  currentLang = e.target.value;
  applyTranslations(currentLang);
  renderLocationStatus();
  renderCollectorCards(myRequests);
  renderRecyclerUI(cachedRequests);
});

// =========================================================
// 4. NAVIGATION & VIEW ROUTER
// =========================================================
const collectorView = document.getElementById("collectorView");
const authView = document.getElementById("authView");
const recyclerView = document.getElementById("recyclerView");
const collectorBtn = document.getElementById("collectorTabBtn");
const recyclerBtn = document.getElementById("recyclerTabBtn");

function renderNavigation() {
  collectorView.classList.remove("active-view");
  authView.classList.remove("active-view");
  recyclerView.classList.remove("active-view");
  collectorBtn.classList.remove("active");
  recyclerBtn.classList.remove("active");

  if (activeTab === "collector") {
    collectorView.classList.add("active-view");
    collectorBtn.classList.add("active");
    setTimeout(() => collectorMap.invalidateSize(), 200);
  } else {
    recyclerBtn.classList.add("active");
    if (currentUser) {
      recyclerView.classList.add("active-view");
      setTimeout(() => recyclerMap.invalidateSize(), 200);
    } else {
      authView.classList.add("active-view");
    }
  }
}

collectorBtn.addEventListener("click", () => { activeTab = "collector"; renderNavigation(); });
recyclerBtn.addEventListener("click", () => { activeTab = "recycler"; renderNavigation(); });

// =========================================================
// 5. COLLECTOR MAP & GEOCODING SEARCH
// =========================================================
let selectedLat = RECYCLER_LAT;
let selectedLng = RECYCLER_LNG;
let selectedAreaLabel = "";

const collectorMap = L.map('collectorMap').setView([selectedLat, selectedLng], 12);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(collectorMap);
let collectorPin = L.marker([selectedLat, selectedLng], { draggable: true }).addTo(collectorMap);

function renderLocationStatus() {
  const label = selectedAreaLabel ? ` (${selectedAreaLabel})` : "";
  document.getElementById("locationStatus").innerHTML =
    `📍 ${t(currentLang, "collector.pinnedLabel")}: <strong>${selectedLat.toFixed(4)}, ${selectedLng.toFixed(4)}</strong>${label}`;
}

function updateCollectorCoords(lat, lng, areaLabel = null) {
  selectedLat = lat;
  selectedLng = lng;
  if (areaLabel) selectedAreaLabel = areaLabel;
  renderLocationStatus();
}

renderLocationStatus();
reverseGeocodeArea(selectedLat, selectedLng).then(label => {
  selectedAreaLabel = label;
  renderLocationStatus();
});

// Interactive Click Pinning
collectorMap.on('click', (e) => {
  collectorPin.setLatLng(e.latlng);
  updateCollectorCoords(e.latlng.lat, e.latlng.lng);
  debouncedReverseGeocode(e.latlng.lat, e.latlng.lng);
});

// Drag Marker Pinning
collectorPin.on('dragend', (e) => {
  const pos = e.target.getLatLng();
  updateCollectorCoords(pos.lat, pos.lng);
  debouncedReverseGeocode(pos.lat, pos.lng);
});

// Pincode / Address Geocoding Search (OpenStreetMap Nominatim)
const locationSearchInput = document.getElementById("locationSearchInput");
const searchLocationBtn = document.getElementById("searchLocationBtn");

searchLocationBtn.addEventListener("click", async () => {
  const queryText = locationSearchInput.value.trim();
  if (!queryText) {
    alert(t(currentLang, "collector.searchLabel"));
    return;
  }

  const originalLabel = t(currentLang, "collector.searchBtn");
  searchLocationBtn.textContent = t(currentLang, "collector.searching");
  searchLocationBtn.disabled = true;

  try {
    const response = await fetch(`https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&q=${encodeURIComponent(queryText)}`);
    const results = await response.json();

    if (results && results.length > 0) {
      const firstResult = results[0];
      const lat = parseFloat(firstResult.lat);
      const lon = parseFloat(firstResult.lon);

      collectorMap.setView([lat, lon], 15);
      collectorPin.setLatLng([lat, lon]);
      updateCollectorCoords(lat, lon, extractAreaLabel(firstResult));
    } else {
      alert("Location/Pincode not found. Please try entering a full address or city name.");
    }
  } catch (error) {
    console.error("Geocoding Error:", error);
    alert("Could not fetch location. Please check your network connection.");
  } finally {
    searchLocationBtn.textContent = originalLabel;
    searchLocationBtn.disabled = false;
  }
});

// Image Preview Handler
const imageInput = document.getElementById("imageInput");
const imagePreview = document.getElementById("imagePreview");
imageInput.addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (file) {
    const reader = new FileReader();
    reader.onload = () => {
      imagePreview.src = reader.result;
      imagePreview.style.display = "block";
    };
    reader.readAsDataURL(file);
  }
});

// =========================================================
// 6. COLLECTOR IDENTITY (anonymous auth — no signup friction)
// =========================================================
// Collectors never see a login screen: each device gets a persistent
// anonymous Firebase Auth identity so their pickups, and only their
// pickups, can be tied together for the "My Submitted Lots" list and
// the earnings/impact stats above the form.
async function ensureCollectorAuth() {
  if (auth.currentUser) {
    collectorUid = auth.currentUser.uid;
    startCollectorListener();
    return collectorUid;
  }
  const cred = await signInAnonymously(auth);
  collectorUid = cred.user.uid;
  startCollectorListener();
  return collectorUid;
}

async function uploadImage(file, uid) {
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
  const imgRef = ref(storage, `pickups/${uid}/${Date.now()}_${safeName}`);
  await uploadBytes(imgRef, file);
  return getDownloadURL(imgRef);
}

// Submit Pickup Form Handler
const collectorForm = document.getElementById("collectorForm");
const submitBtn = document.getElementById("submitBtn");

collectorForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  submitBtn.disabled = true;
  submitBtn.textContent = t(currentLang, "collector.saving");

  try {
    const uid = await ensureCollectorAuth();
    const type = document.getElementById("eWasteType").value;
    const weight = Number(document.getElementById("weight").value);
    const file = imageInput.files[0];
    const imageUrl = await uploadImage(file, uid);

    await addDoc(collection(db, "pickup_requests"), {
      type,
      weight,
      lat: selectedLat,
      lng: selectedLng,
      areaLabel: selectedAreaLabel || "Unspecified Area",
      imageUrl,
      status: "Requested",
      collectorId: uid,
      statusHistory: [{ status: "Requested", at: new Date().toISOString(), by: uid }],
      timestamp: serverTimestamp()
    });

    collectorForm.reset();
    imagePreview.style.display = "none";
  } catch (err) {
    console.error("Firestore Error:", err);
    alert("Error saving request: " + err.message);
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = t(currentLang, "collector.submitBtn");
  }
});

function startCollectorListener() {
  if (unsubCollector || !collectorUid) return;
  const cq = query(
    collection(db, "pickup_requests"),
    where("collectorId", "==", collectorUid),
    orderBy("timestamp", "desc")
  );
  unsubCollector = onSnapshot(cq, (snapshot) => {
    myRequests = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    renderCollectorCards(myRequests);
  }, (err) => console.error("Collector listener error:", err));
}

// =========================================================
// 7. RECYCLER AUTHENTICATION
// =========================================================
const authForm = document.getElementById("authForm");
const authTitle = document.getElementById("authTitle");
const authSubmitBtn = document.getElementById("authSubmitBtn");
const authToggleText = document.getElementById("authToggleText");
const switchAuthModeBtn = document.getElementById("switchAuthModeBtn");

switchAuthModeBtn.addEventListener("click", () => {
  isSignUpMode = !isSignUpMode;
  if (isSignUpMode) {
    authTitle.setAttribute("data-i18n", "auth.createTitle");
    authSubmitBtn.setAttribute("data-i18n", "auth.signupBtn");
    authToggleText.setAttribute("data-i18n", "auth.haveAccount");
    switchAuthModeBtn.setAttribute("data-i18n", "auth.toLogin");
  } else {
    authTitle.setAttribute("data-i18n", "auth.title");
    authSubmitBtn.setAttribute("data-i18n", "auth.loginBtn");
    authToggleText.setAttribute("data-i18n", "auth.needAccount");
    switchAuthModeBtn.setAttribute("data-i18n", "auth.toSignup");
  }
  applyTranslations(currentLang, document.getElementById("authView"));
});

authForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = document.getElementById("authEmail").value;
  const password = document.getElementById("authPassword").value;
  authSubmitBtn.disabled = true;

  try {
    if (isSignUpMode) {
      const cred = await createUserWithEmailAndPassword(auth, email, password);
      // Firestore security rules check for this doc to tell a recycler
      // apart from an anonymous collector — see firestore.rules.
      await setDoc(doc(db, "recyclers", cred.user.uid), {
        email,
        createdAt: serverTimestamp()
      });
    } else {
      await signInWithEmailAndPassword(auth, email, password);
    }
  } catch (err) {
    alert("Authentication Error: " + err.message);
  } finally {
    authSubmitBtn.disabled = false;
  }
});

document.getElementById("logoutBtn").addEventListener("click", async () => {
  await signOut(auth);
  ensureCollectorAuth(); // restore this device's anonymous collector identity
});

onAuthStateChanged(auth, (user) => {
  if (user && user.isAnonymous) {
    collectorUid = user.uid;
    currentUser = null;
    startCollectorListener();
  } else if (user) {
    currentUser = user;
    document.getElementById("userEmailBadge").textContent =
      `${t(currentLang, "recycler.loggedInAs")} ${user.email}`;
    startRecyclerListener();
  } else {
    currentUser = null;
    stopRecyclerListener();
  }
  renderNavigation();
});

function startRecyclerListener() {
  if (unsubRecycler) return;
  const rq = query(collection(db, "pickup_requests"), orderBy("timestamp", "desc"));
  unsubRecycler = onSnapshot(rq, (snapshot) => {
    cachedRequests = snapshot.docs.map(d => {
      const data = d.data();
      const dist = calculateDistance(RECYCLER_LAT, RECYCLER_LNG, data.lat || RECYCLER_LAT, data.lng || RECYCLER_LNG);
      return { id: d.id, ...data, distance: Number(dist) };
    });
    cachedRequests.sort((a, b) => a.distance - b.distance);
    renderRecyclerUI(cachedRequests);
  }, (err) => console.error("Recycler listener error:", err));
}

function stopRecyclerListener() {
  if (unsubRecycler) {
    unsubRecycler();
    unsubRecycler = null;
  }
  cachedRequests = [];
}

// =========================================================
// 8. RATE CARD (editable in Firestore without a redeploy)
// =========================================================
async function loadRateCard() {
  try {
    const snap = await getDoc(doc(db, "config", "rateCard"));
    if (snap.exists()) {
      rateCard = { ...DEFAULT_RATE_CARD, ...snap.data() };
    }
  } catch (err) {
    console.warn("Using default rate card — config/rateCard not readable yet:", err);
  }
}

// =========================================================
// 9. RECYCLER DASHBOARD RENDERING & AREA LEADERBOARD
// =========================================================
const recyclerMap = L.map('recyclerMap').setView([RECYCLER_LAT, RECYCLER_LNG], 12);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(recyclerMap);

L.marker([RECYCLER_LAT, RECYCLER_LNG])
  .addTo(recyclerMap)
  .bindPopup("<b>🏢 Recycler Processing Hub</b>")
  .openPopup();

let recyclerMapMarkers = [];

function renderCollectorCards(requests) {
  const container = document.getElementById("collectorStatusList");

  if (requests.length === 0) {
    container.innerHTML = `<p class="loading">${t(currentLang, "collector.noLots")}</p>`;
  } else {
    container.innerHTML = requests.map(item => `
      <div class="item-card">
        <img src="${item.imageUrl}" class="thumb-img" alt="" />
        <div class="item-info">
          <h4>${categoryLabel(item.type)}</h4>
          ${buildProgressTrackHTML(item.status)}
          <p><strong>${t(currentLang, "collector.weightLine")}:</strong> ${item.weight} kg</p>
          ${item.earnings ? `<p class="earnings-line">${t(currentLang, "collector.earningsLine")}: ${t(currentLang, "common.currency")}${Number(item.earnings).toFixed(0)}</p>` : ""}
        </div>
      </div>
    `).join("");
  }

  const totalWeight = requests.reduce((sum, r) => sum + Number(r.weight || 0), 0);
  const totalEarnings = requests.reduce((sum, r) => sum + Number(r.earnings || 0), 0);
  animateStat("statRequests", requests.length);
  animateStat("statWeight", totalWeight, 1);
  animateStat("statEarnings", totalEarnings, 0, t(currentLang, "common.currency"));
}

function renderLeaderboard(requests) {
  const container = document.getElementById("areaLeaderboard");
  const totals = {};

  requests.forEach(r => {
    if (r.status !== "Completed") return;
    const key = r.areaLabel || "Unspecified Area";
    if (!totals[key]) totals[key] = { earnings: 0, weight: 0, lots: 0 };
    totals[key].earnings += Number(r.earnings || 0);
    totals[key].weight += Number(r.weight || 0);
    totals[key].lots += 1;
  });

  const ranked = Object.entries(totals)
    .sort((a, b) => b[1].earnings - a[1].earnings)
    .slice(0, 6);

  if (ranked.length === 0) {
    container.innerHTML = `<li class="loading">${t(currentLang, "recycler.leaderboardEmpty")}</li>`;
    return;
  }

  const currency = t(currentLang, "common.currency");
  container.innerHTML = ranked.map(([area, figures], i) => `
    <li class="leaderboard-item">
      <span class="leaderboard-rank">#${i + 1}</span>
      <span class="leaderboard-name">${area}</span>
      <span class="leaderboard-figures">
        <strong>${currency}${figures.earnings.toFixed(0)}</strong> · ${figures.weight.toFixed(1)} kg · 📦 ${figures.lots}
      </span>
    </li>
  `).join("");
}

async function advanceStatus(id, newStatus) {
  const item = cachedRequests.find(r => r.id === id);
  const updates = {
    status: newStatus,
    statusHistory: arrayUnion({
      status: newStatus,
      at: new Date().toISOString(),
      by: currentUser ? currentUser.uid : "unknown"
    })
  };

  // Computed here for immediate UI feedback. If you deploy the optional
  // Cloud Function trigger in functions-index.js, it will recompute and
  // overwrite this figure server-side using the authoritative rate card,
  // so a tampered client value can't stick.
  if (newStatus === "Completed" && item) {
    const rate = rateCard[item.type] ?? 0;
    updates.earnings = Math.round(Number(item.weight) * rate * 100) / 100;
  }

  try {
    await updateDoc(doc(db, "pickup_requests", id), updates);
  } catch (err) {
    console.error("Status update failed:", err);
    alert(t(currentLang, "bot.error"));
  }
}

function renderRecyclerUI(requests) {
  const container = document.getElementById("recyclerMatchingList");

  recyclerMapMarkers.forEach(m => recyclerMap.removeLayer(m));
  recyclerMapMarkers = [];

  const filtered = requests.filter(req => currentFilter === 'all' || req.status === currentFilter);

  if (filtered.length === 0) {
    container.innerHTML = `<p class="loading">${t(currentLang, "recycler.noMatch")}</p>`;
  } else {
    container.innerHTML = filtered.map(item => {
      if (item.lat && item.lng) {
        const marker = L.marker([item.lat, item.lng])
          .addTo(recyclerMap)
          .bindPopup(`<b>${categoryLabel(item.type)}</b><br>${t(currentLang, "recycler.distance")}: <strong>${item.distance} km</strong><br>${statusBadge(item.status)}`);
        recyclerMapMarkers.push(marker);
      }

      let actionBtn = "";
      if (item.status === 'Requested') {
        actionBtn = `<button class="btn accept-btn" data-id="${item.id}" data-status="Accepted">${t(currentLang, "recycler.acceptBtn")}</button>`;
      } else if (item.status === 'Accepted') {
        actionBtn = `<button class="btn complete-btn" data-id="${item.id}" data-status="Completed">${t(currentLang, "recycler.completeBtn")}</button>`;
      } else {
        actionBtn = `<span class="badge completed">✅ ${t(currentLang, "recycler.processed")}</span>`;
      }

      const currency = t(currentLang, "common.currency");
      return `
        <div class="item-card">
          <img src="${item.imageUrl}" class="thumb-img" alt="" />
          <div class="item-info">
            <h4>${categoryLabel(item.type)} (${item.weight} kg)</h4>
            ${buildProgressTrackHTML(item.status)}
            <p class="distance-tag">📏 <strong>${item.distance} km</strong> ${t(currentLang, "recycler.distance")}</p>
            <p>${t(currentLang, "collector.statusLine")}: ${statusBadge(item.status)}</p>
            ${item.earnings ? `<p class="earnings-line">${t(currentLang, "collector.earningsLine")}: ${currency}${Number(item.earnings).toFixed(0)}</p>` : ""}
            <div class="action-box">${actionBtn}</div>
          </div>
        </div>
      `;
    }).join("");
  }

  container.querySelectorAll("button[data-id]").forEach(btn => {
    btn.addEventListener("click", (e) => {
      const id = e.currentTarget.getAttribute("data-id");
      const newStatus = e.currentTarget.getAttribute("data-status");
      advanceStatus(id, newStatus);
    });
  });

  renderLeaderboard(requests);
}

// Filter button logic
document.querySelectorAll(".filter-btn").forEach(btn => {
  btn.addEventListener("click", (e) => {
    document.querySelectorAll(".filter-btn").forEach(b => b.classList.remove("active"));
    e.target.classList.add("active");
    currentFilter = e.target.getAttribute("data-filter");
    renderRecyclerUI(cachedRequests);
  });
});

// =========================================================
// 10. AI ASSISTANT BOT (proxied through a Cloud Function —
//     the Gemini key never reaches the browser)
// =========================================================
const toggleBotBtn = document.getElementById("toggleBotBtn");
const closeBotBtn = document.getElementById("closeBotBtn");
const botChatWindow = document.getElementById("botChatWindow");
const sendBotBtn = document.getElementById("sendBotBtn");
const botInput = document.getElementById("botInput");
const botMessages = document.getElementById("botMessages");

toggleBotBtn.addEventListener("click", () => botChatWindow.classList.toggle("hidden"));
closeBotBtn.addEventListener("click", () => botChatWindow.classList.add("hidden"));

function appendMessage(sender, text) {
  const msgDiv = document.createElement("div");
  msgDiv.className = sender === "user" ? "user-msg" : "bot-msg";
  msgDiv.textContent = text;
  botMessages.appendChild(msgDiv);
  botMessages.scrollTop = botMessages.scrollHeight;
}

sendBotBtn.addEventListener("click", handleBotSend);
botInput.addEventListener("keypress", (e) => { if (e.key === "Enter") handleBotSend(); });

async function handleBotSend() {
  const userText = botInput.value.trim();
  if (!userText) return;

  appendMessage("user", userText);
  botInput.value = "";

  const loadingMsg = document.createElement("div");
  loadingMsg.className = "bot-msg";
  loadingMsg.textContent = t(currentLang, "bot.thinking");
  botMessages.appendChild(loadingMsg);
  botMessages.scrollTop = botMessages.scrollHeight;

  try {
    const langName = languageSelect.options[languageSelect.selectedIndex].text;
    const askAssistant = httpsCallable(functions, "askAssistant");
    const result = await askAssistant({ prompt: userText, languageName: langName });
    loadingMsg.remove();
    appendMessage("bot", (result.data && result.data.text) || t(currentLang, "bot.fallback"));
  } catch (err) {
    loadingMsg.remove();
    console.error("AI Bot Error:", err);
    appendMessage("bot", t(currentLang, "bot.error"));
  }
}

// =========================================================
// 11. INIT
// =========================================================
applyTranslations(currentLang);
loadRateCard();
ensureCollectorAuth();
renderNavigation();
