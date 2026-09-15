import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-storage.js";
import { getFunctions } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-functions.js";

const firebaseConfig = {
  apiKey: "AIzaSyCBQ2Ke0Omwjjg2-SspoYRxgyLbI1sGslE",
  authDomain: "kabadiwala-connect.firebaseapp.com",
  databaseURL: "https://kabadiwala-connect-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "kabadiwala-connect",
  storageBucket: "kabadiwala-connect.firebasestorage.app",
  messagingSenderId: "926766533300",
  appId: "1:926766533300:web:9c9815ce38afd13dbce5e1",
  measurementId: "G-YP7CT5CE3J"
};

// Note: this apiKey is a public Firebase *client* identifier, not a secret —
// it's safe in front-end code because Firestore/Storage/Auth access is
// actually governed by the security rules deployed alongside this project
// (see firestore.rules and storage.rules). It is NOT the same kind of key
// as the Gemini key that used to live in app.js, which genuinely was secret
// and has been moved server-side into a Cloud Function.
const app = initializeApp(firebaseConfig);

export const db = getFirestore(app);
export const auth = getAuth(app);
export const storage = getStorage(app);
// Region left as default ("us-central1"). If you deploy the Cloud Function
// to a different region, pass it here: getFunctions(app, "asia-south1").
export const functions = getFunctions(app);
