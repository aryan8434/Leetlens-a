import { initializeApp } from "firebase/app";
import { getAnalytics, isSupported } from "firebase/analytics";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyDntkrcYZH4iRvk94GdkLk-3gX2foDzx0I",
  authDomain: "leetlens.firebaseapp.com",
  projectId: "leetlens",
  storageBucket: "leetlens.firebasestorage.app",
  messagingSenderId: "767069243250",
  appId: "1:767069243250:web:b23306fe9eebc21d3cbfeb",
  measurementId: "G-EDBX9RE40N",
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

let analytics = null;
isSupported().then((supported) => {
  if (supported) {
    analytics = getAnalytics(app);
  }
});

export { app, analytics, db };
