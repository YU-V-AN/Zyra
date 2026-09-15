// =========================================================
// Tech Nova — Cloud Functions
// Deploy this as functions/index.js in your Firebase project
// (see SETUP.md for the full deploy steps).
// =========================================================
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { defineSecret } = require("firebase-functions/params");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

initializeApp();
const db = getFirestore();

// Set with: firebase functions:secrets:set GEMINI_API_KEY
// Never hardcode the key here or anywhere client-side.
const GEMINI_API_KEY = defineSecret("GEMINI_API_KEY");

// ---------------------------------------------------------
// askAssistant — proxies the Gemini call so the API key never
// reaches the browser. Called from app.js via httpsCallable.
// ---------------------------------------------------------
exports.askAssistant = onCall({ secrets: [GEMINI_API_KEY] }, async (request) => {
  const prompt = ((request.data && request.data.prompt) || "").toString().slice(0, 2000);
  const languageName = ((request.data && request.data.languageName) || "English").toString().slice(0, 40);

  if (!prompt.trim()) {
    throw new HttpsError("invalid-argument", "A non-empty prompt is required.");
  }

  const systemPrompt =
    `You are an expert assistant for the e-waste recycling platform "Tech Nova". ` +
    `Respond concisely in ${languageName}. Explain clearly what to do with the items ` +
    `or how to use the app, based on this user request: "${prompt}"`;

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY.value()}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: systemPrompt }] }] })
      }
    );

    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!text) {
      console.error("Gemini response missing text:", JSON.stringify(data));
      throw new HttpsError("internal", "The assistant did not return a usable response.");
    }

    return { text };
  } catch (err) {
    console.error("askAssistant error:", err);
    throw new HttpsError("internal", "Could not reach the assistant right now.");
  }
});

// ---------------------------------------------------------
// recomputeEarningsOnComplete — whenever a pickup_requests doc
// transitions into "Completed", this recalculates `earnings`
// server-side from the trusted config/rateCard document and
// overwrites whatever the client sent. This is what makes the
// client-side earnings figure in app.js safe to show immediately
// without trusting it as the final number.
// ---------------------------------------------------------
exports.recomputeEarningsOnComplete = onDocumentUpdated("pickup_requests/{requestId}", async (event) => {
  const before = event.data.before.data();
  const after = event.data.after.data();

  if (after.status !== "Completed" || before.status === "Completed") {
    return; // only act on the transition INTO Completed, once
  }

  const rateSnap = await db.collection("config").doc("rateCard").get();
  const rateCard = rateSnap.exists ? rateSnap.data() : {};
  const rate = Number(rateCard[after.type] || 0);
  const authoritativeEarnings = Math.round(Number(after.weight || 0) * rate * 100) / 100;

  if (authoritativeEarnings !== after.earnings) {
    await event.data.after.ref.update({ earnings: authoritativeEarnings });
  }
});
