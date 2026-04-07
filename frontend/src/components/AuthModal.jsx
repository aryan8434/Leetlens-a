import React, { useState } from "react";
import { auth } from "../firebase";
import { 
  signInWithEmailAndPassword, 
  createUserWithEmailAndPassword, 
  GoogleAuthProvider, 
  signInWithPopup
} from "firebase/auth";

export default function AuthModal({ onClose }) {
  const [isSignUp, setIsSignUp] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  const handleGoogleSignIn = async () => {
    setError("");
    setMessage("");
    setLoading(true);
    try {
      const provider = new GoogleAuthProvider();
      await signInWithPopup(auth, provider);
      onClose();
    } catch (err) {
      setError(err.message || "Failed to sign in with Google.");
    } finally {
      setLoading(false);
    }
  };

  const handleEmailAuth = async (e) => {
    e.preventDefault();
    setError("");
    setMessage("");
    setLoading(true);

    try {
      if (isSignUp) {
        await createUserWithEmailAndPassword(auth, email, password);
        onClose(); // Instantly log in and close modal
      } else {
        await signInWithEmailAndPassword(auth, email, password);
        onClose(); // Instantly log in and close modal
      }
    } catch (err) {
      setError(err.message || "Authentication failed.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={styles.overlay}>
      <div style={styles.modalContent}>
        <button style={styles.closeBtn} onClick={onClose}>&times;</button>
        <h2 style={styles.title}>{isSignUp ? "Sign Up" : "Log In"}</h2>
        
        {error && <p style={styles.error}>{error}</p>}
        {message && <p style={styles.success}>{message}</p>}

        <form onSubmit={handleEmailAuth} style={styles.form}>
          <input 
            type="email" 
            placeholder="Email address" 
            value={email} 
            onChange={(e) => setEmail(e.target.value)} 
            required 
            style={styles.input}
          />
          <input 
            type="password" 
            placeholder="Password (min 6 characters)" 
            value={password} 
            onChange={(e) => setPassword(e.target.value)} 
            required 
            style={styles.input}
          />
          <button type="submit" disabled={loading} style={styles.submitBtn}>
            {loading ? "Please wait..." : (isSignUp ? "Sign Up" : "Log In")}
          </button>
        </form>

        <div style={styles.divider}><span style={styles.dividerText}>OR</span></div>

        <button onClick={handleGoogleSignIn} disabled={loading} style={styles.googleBtn}>
           Sign in with Google
        </button>

        <p style={{textAlign: "center", marginTop: "1rem"}}>
          {isSignUp ? "Already have an account?" : "Don't have an account?"}{" "}
          <button type="button" onClick={() => setIsSignUp(!isSignUp)} style={styles.toggleBtn}>
            {isSignUp ? "Log In" : "Sign Up"}
          </button>
        </p>
      </div>
    </div>
  );
}

const styles = {
  overlay: {
    position: "fixed", top: 0, left: 0, width: "100%", height: "100%",
    backgroundColor: "rgba(0,0,0,0.5)", zIndex: 9999,
    display: "flex", justifyContent: "center", alignItems: "center"
  },
  modalContent: {
    backgroundColor: "#1e293b", padding: "2rem", borderRadius: "12px",
    width: "400px", maxWidth: "90%", position: "relative",
    boxShadow: "0 10px 25px rgba(0,0,0,0.5)", color: "#fff"
  },
  closeBtn: {
    position: "absolute", top: "10px", right: "15px", background: "none",
    border: "none", color: "#ccc", fontSize: "1.5rem", cursor: "pointer"
  },
  title: {
    marginTop: 0, textAlign: "center", marginBottom: "1.5rem", color: "#60a5fa"
  },
  form: {
    display: "flex", flexDirection: "column", gap: "15px"
  },
  input: {
    padding: "12px", borderRadius: "8px", border: "1px solid #475569",
    backgroundColor: "#0f172a", color: "#fff", fontSize: "1rem"
  },
  submitBtn: {
    padding: "12px", borderRadius: "8px", border: "none",
    backgroundColor: "#3b82f6", color: "#fff", fontWeight: "bold", fontSize: "1rem",
    cursor: "pointer", marginTop: "5px"
  },
  divider: {
    margin: "20px 0", borderBottom: "1px solid #475569", position: "relative"
  },
  dividerText: {
    position: "absolute", top: "-10px", left: "50%", transform: "translateX(-50%)",
    backgroundColor: "#1e293b", padding: "0 10px", color: "#94a3b8", fontSize: "0.9rem"
  },
  googleBtn: {
    width: "100%", padding: "12px", borderRadius: "8px", border: "1px solid #fff",
    backgroundColor: "#fff", color: "#000", fontWeight: "bold", fontSize: "1rem",
    cursor: "pointer", marginTop: "10px"
  },
  toggleBtn: {
    background: "none", border: "none", color: "#60a5fa", cursor: "pointer",
    textDecoration: "underline", fontSize: "1rem"
  },
  error: {
    color: "#ef4444", fontSize: "0.9rem", textAlign: "center", marginBottom: "10px"
  },
  success: {
    color: "#22c55e", fontSize: "0.9rem", textAlign: "center", marginBottom: "10px"
  }
};
