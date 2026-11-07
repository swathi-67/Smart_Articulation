// Import Firebase
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-auth.js";

// Your Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyC_tyzjoVvGxF7KM5xeocoyrmowHOe5Gqo",
  authDomain: "articulation-app-ff6e7.firebaseapp.com",
  projectId: "articulation-app-ff6e7",
  storageBucket: "articulation-app-ff6e7.firebasestorage.app",
  messagingSenderId: "257294339130",
  appId: "1:257294339130:web:4fc27b4c846ccd9d467903"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const provider = new GoogleAuthProvider();
export { signInWithPopup };