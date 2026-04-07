import React, { createContext, useContext, useEffect, useState } from "react";
import { auth } from "../firebase";
import { onAuthStateChanged, signOut as firebaseSignOut } from "firebase/auth";

const AuthContext = createContext();

export function useAuth() {
  return useContext(AuthContext);
}

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || "").replace(
  /\/$/,
  "",
);

export function AuthProvider({ children }) {
  const [currentUser, setCurrentUser] = useState(null);
  const [credits, setCredits] = useState(0);
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);

  async function syncUserWithBackend(user) {
    if (!user) {
      setCredits(0);
      return;
    }

    try {
      const token = await user.getIdToken();
      const response = await fetch(`${API_BASE_URL}/api/auth/sync`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
      });
      if (response.ok) {
        const data = await response.json();
        setCredits(data.credits);
        if (data.user) {
          setProfile(data.user);
        }
      }
    } catch (error) {
      console.error("Error syncing user with backend:", error);
    }
  }

  async function getAuthHeaders() {
    if (!currentUser) {
      throw new Error("Not authenticated.");
    }

    const token = await currentUser.getIdToken();
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    };
  }

  const refreshCredits = async () => {
    if (currentUser) {
      await syncUserWithBackend(currentUser);
    }
  };

  const refreshProfile = async () => {
    if (!currentUser) {
      return null;
    }

    const headers = await getAuthHeaders();
    const response = await fetch(`${API_BASE_URL}/api/profile`, {
      method: "GET",
      headers,
    });

    if (!response.ok) {
      throw new Error("Unable to load profile.");
    }

    const data = await response.json();
    setProfile(data.user || null);
    if (typeof data.credits === "number") {
      setCredits(data.credits);
    }
    return data.user || null;
  };

  const saveProfile = async (updates) => {
    if (!currentUser) {
      throw new Error("Not authenticated.");
    }

    const headers = await getAuthHeaders();
    const response = await fetch(`${API_BASE_URL}/api/profile`, {
      method: "PUT",
      headers,
      body: JSON.stringify(updates || {}),
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error || "Unable to save profile.");
    }

    setProfile(payload.user || null);
    if (typeof payload.credits === "number") {
      setCredits(payload.credits);
    }
    return payload.user || null;
  };

  const purchaseCredits = async (packageKey) => {
    if (!currentUser) {
      throw new Error("Not authenticated.");
    }

    const headers = await getAuthHeaders();
    const response = await fetch(`${API_BASE_URL}/api/credits/purchase`, {
      method: "POST",
      headers,
      body: JSON.stringify({ packageKey }),
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error || "Unable to add credits.");
    }

    if (typeof payload.credits === "number") {
      setCredits(payload.credits);
    }
    if (payload.user) {
      setProfile(payload.user);
    }

    return payload;
  };

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      setCurrentUser(user);
      setProfile(null);
      await syncUserWithBackend(user);
      setLoading(false);
    });
    return unsubscribe;
  }, []);

  const logout = () => {
    setCredits(0);
    setProfile(null);
    return firebaseSignOut(auth);
  };

  const value = {
    currentUser,
    credits,
    profile,
    refreshCredits,
    refreshProfile,
    saveProfile,
    purchaseCredits,
    setCredits,
    logout,
  };

  return (
    <AuthContext.Provider value={value}>
      {!loading && children}
    </AuthContext.Provider>
  );
}
