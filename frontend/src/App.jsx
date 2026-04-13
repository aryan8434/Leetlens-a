import { useEffect, useState, useRef } from "react";
import { UAParser } from "ua-parser-js";
import "./App.css";
import { useAuth } from "./contexts/AuthContext";
import AuthModal from "./components/AuthModal";
import { db } from "./firebase";
import {
  collection,
  addDoc,
  doc,
  setDoc,
  serverTimestamp,
} from "firebase/firestore";

function getDailyDateFolder() {
  const d = new Date();
  const day = d.getDate();
  const monthNames = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];
  const month = monthNames[d.getMonth()];
  const year = d.getFullYear();
  return `${day} ${month} ${year}`;
}

function getVisitorId() {
  let vid = localStorage.getItem("leetlens_visitor_id");
  if (!vid) {
    vid =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : Math.random().toString(36).substring(2) + Date.now().toString(36);
    localStorage.setItem("leetlens_visitor_id", vid);
  }
  return vid;
}

const REPORT_CACHE_KEY = "leetlensCoachReports_v2";
const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || "").replace(
  /\/$/,
  "",
);

function toApiUrl(path) {
  return API_BASE_URL ? `${API_BASE_URL}${path}` : path;
}

function loadReportCache() {
  try {
    const raw = localStorage.getItem(REPORT_CACHE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (_error) {
    return {};
  }
}

function saveReportCache(cache) {
  try {
    localStorage.setItem(REPORT_CACHE_KEY, JSON.stringify(cache));
  } catch (_error) {
    // Ignore storage failures and continue with in-memory state.
  }
}

function cleanReportLine(rawLine) {
  if (!rawLine) {
    return "";
  }

  return String(rawLine)
    .replace(/^\s*#{1,6}\s*/, "")
    .replace(/^\s*[-*+]\s+/, "")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/__(.*?)__/g, "$1")
    .replace(/`(.*?)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function getSectionTitleFromLine(line) {
  const numbered = line.match(/^\d+[.)]\s+(.+?)\s*:?$/);
  if (numbered) {
    return numbered[1];
  }

  const knownHeading = line.match(
    /^(overall skill score|current insights|company readiness(?:\s*\(%\))?|topic breakdown|key weaknesses|improvement plan(?:\s*\([^)]*\))?|final verdict|estimated time to reach faang level)\s*:?$/i,
  );
  if (knownHeading) {
    return knownHeading[1];
  }

  return null;
}

function parseReportSections(reportText) {
  if (!reportText) {
    return [];
  }

  const lines = reportText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const sections = [];
  let current = null;

  lines.forEach((rawLine) => {
    const line = cleanReportLine(rawLine);
    if (!line) {
      return;
    }

    const sectionTitle = getSectionTitleFromLine(line);
    if (sectionTitle) {
      current = {
        title: sectionTitle,
        items: [],
      };
      sections.push(current);
      return;
    }

    if (!current) {
      current = {
        title: "Evaluation Report",
        items: [],
      };
      sections.push(current);
    }

    current.items.push(line);
  });

  return sections;
}

function normalizeSectionTitle(title) {
  const str = String(title || "");
  return str
    .toLowerCase()
    .replace(/\([^)]*\)/g, "")
    .replace(/[^a-z\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function findSection(sections, includesText) {
  return sections.find((section) =>
    normalizeSectionTitle(section.title).includes(includesText),
  );
}

function extractScore(reportText) {
  if (!reportText) {
    return null;
  }

  const match = reportText.match(/(?:SCORE\s*:?\s*)?(\d{1,3})(?:\/100|\s+out of 100|%)/i) || reportText.match(/\b(\d{1,3})\b/);
  if (!match) {
    return null;
  }

  const score = Number(match[1]);
  if (Number.isNaN(score) || score < 0 || score > 100) {
    return null;
  }

  return score;
}

function getSectionTone(title) {
  const normalized = normalizeSectionTitle(title);
  if (normalized.includes("current insights")) {
    return "insights";
  }
  if (normalized.includes("company readiness")) {
    return "readiness";
  }
  if (normalized.includes("weakness")) {
    return "weakness";
  }
  if (normalized.includes("improvement plan")) {
    return "plan";
  }
  if (normalized.includes("verdict")) {
    return "verdict";
  }
  return "default";
}

function renderLineWithHighlights(line) {
  const cleanLine = cleanReportLine(line);
  const tokens = cleanLine.split(
    /(Hard|hard|Medium|medium|Easy|easy|FAANG|Product-based|Service-based|strong|Strong|weak|Weak|\d+(?:\.\d+)?%)/,
  );

  return tokens.map((token, index) => {
    if (/^FAANG$/.test(token)) {
      return (
        <span
          key={`${token}-${index}`}
          className="token-faang-custom"
          aria-label="FAANG"
        >
          <span className="faang-f">F</span>
          <span className="faang-a1">A</span>
          <span className="faang-a2">A</span>
          <span className="faang-n">N</span>
          <span className="faang-g">G</span>
        </span>
      );
    }

    let className = "token-default";
    if (/^Hard$|^hard$/.test(token)) {
      className = "token-hard";
    } else if (/^Medium$|^medium$/.test(token)) {
      className = "token-medium";
    } else if (/^Easy$|^easy$/.test(token)) {
      className = "token-easy";
    } else if (/^Product-based$/.test(token)) {
      className = "token-product";
    } else if (/^Service-based$/.test(token)) {
      className = "token-service";
    } else if (/^strong$|^Strong$/.test(token)) {
      className = "token-strong";
    } else if (/^weak$|^Weak$/.test(token)) {
      className = "token-weak";
    } else if (/^\d+(?:\.\d+)?%$/.test(token)) {
      className = "token-percent";
    }

    return (
      <span key={`${token}-${index}`} className={className}>
        {token}
      </span>
    );
  });
}

function pairReadinessItems(items) {
  const pairs = [];
  for (let i = 0; i < items.length; i += 1) {
    const current = items[i] || "";
    const next = items[i + 1] || "";
    if (next && next.toLowerCase().startsWith("reason:")) {
      pairs.push({
        heading: current,
        details: next,
      });
      i += 1;
    } else {
      pairs.push({
        heading: current,
        details: "",
      });
    }
  }
  return pairs;
}

function parseReadinessHeading(headingLine) {
  const match = headingLine.match(/^\s*([^:]+):\s*(\d{1,3})\s*\/\s*100\s*$/i);
  if (!match) {
    return {
      label: headingLine.replace(/:\s*$/, ""),
      score: null,
    };
  }

  return {
    label: match[1],
    score: Number(match[2]),
  };
}

function stripTrailingColon(text) {
  return (text || "").replace(/:\s*$/, "");
}

function getAverageReadiness(items) {
  const scores = items
    .map((row) => parseReadinessHeading(row.heading).score)
    .filter((score) => typeof score === "number" && !Number.isNaN(score));

  if (!scores.length) {
    return null;
  }

  return Math.round(
    scores.reduce((sum, value) => sum + value, 0) / scores.length,
  );
}

function pairHeadingDetailItems(items) {
  const pairs = [];
  for (let i = 0; i < items.length; i += 1) {
    const current = items[i] || "";
    const next = items[i + 1] || "";
    if (current.endsWith(":") && next) {
      pairs.push({
        heading: current,
        details: next,
      });
      i += 1;
    } else {
      pairs.push({
        heading: current,
        details: "",
      });
    }
  }
  return pairs;
}

const TOPIC_COLORS = [
  "#22d3ee",
  "#38bdf8",
  "#60a5fa",
  "#818cf8",
  "#a78bfa",
  "#34d399",
  "#f59e0b",
  "#f97316",
];

function getTopicColor(index) {
  return TOPIC_COLORS[index % TOPIC_COLORS.length];
}

function getMonthTicks(heatmap) {
  const ticks = [];
  let lastMonth = "";

  heatmap.forEach((item, index) => {
    const date = new Date(`${item.date}T00:00:00`);
    const month = date.toLocaleString("en-US", { month: "short" });
    if (month !== lastMonth) {
      ticks.push({ month, index });
      lastMonth = month;
    }
  });

  return ticks;
}

function getTopicBand(percentage) {
  if (percentage >= 40) {
    return "Strong";
  }
  if (percentage >= 20) {
    return "Average";
  }
  return "Weak";
}

function getHeatLevel(count, maxCount) {
  if (count <= 0) {
    return 0;
  }

  const ratio = count / Math.max(1, maxCount);
  if (ratio >= 0.75) {
    return 4;
  }
  if (ratio >= 0.5) {
    return 3;
  }
  if (ratio >= 0.25) {
    return 2;
  }
  return 1;
}

async function readApiPayload(response) {
  const raw = await response.text();
  if (!raw) {
    return {};
  }

  try {
    return JSON.parse(raw);
  } catch (_error) {
    return { raw };
  }
}

function buildHttpErrorMessage(response, payload, fallback) {
  const main = payload?.error || fallback;
  const rawText =
    typeof payload?.raw === "string"
      ? payload.raw
          .replace(/<[^>]*>/g, " ")
          .replace(/\s+/g, " ")
          .trim()
      : "";
  const details = payload?.details
    ? ` (${payload.details})`
    : rawText
      ? ` (${rawText.slice(0, 160)})`
      : "";
  const statusLabel = response.statusText
    ? `HTTP ${response.status} ${response.statusText}`
    : `HTTP ${response.status}`;
  return `${main}${details} [${statusLabel}]`;
}

function getUserInitials(user, profile) {
  const source = profile?.name || user?.displayName || user?.email || "User";
  const parts = source.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) {
    return "U";
  }
  if (parts.length === 1) {
    return parts[0].slice(0, 2).toUpperCase();
  }
  return `${parts[0][0] || ""}${parts[1][0] || ""}`.toUpperCase();
}

function App() {
  const [username, setUsername] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [analysis, setAnalysis] = useState(null);
  const [coachLoading, setCoachLoading] = useState(false);
  const [coachError, setCoachError] = useState("");
  const [coachReport, setCoachReport] = useState("");
  const [coachSavedAt, setCoachSavedAt] = useState("");
  const [showAllTopics, setShowAllTopics] = useState(false);
  const [showReportPage, setShowReportPage] = useState(false);
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [showProfileMenu, setShowProfileMenu] = useState(false);
  const [showOutOfCreditsModal, setShowOutOfCreditsModal] = useState(false);
  const [showProfilePage, setShowProfilePage] = useState(false);
  const [showCreditsPage, setShowCreditsPage] = useState(false);
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileError, setProfileError] = useState("");
  const [profileSavedMessage, setProfileSavedMessage] = useState("");
  const [purchaseLoadingKey, setPurchaseLoadingKey] = useState("");
  const [purchaseMessage, setPurchaseMessage] = useState("");
  const [purchaseError, setPurchaseError] = useState("");
  const [profileForm, setProfileForm] = useState({
    name: "",
    email: "",
    age: "",
    location: "",
    bio: "",
  });
  const {
    currentUser,
    credits,
    profile,
    logout,
    refreshCredits,
    refreshProfile,
    saveProfile,
    purchaseCredits,
  } = useAuth();
  const hasLoggedVisit = useRef(false);
  const profileMenuRef = useRef(null);

  useEffect(() => {
    if (hasLoggedVisit.current) return;
    hasLoggedVisit.current = true;

    const logVisit = async () => {
      const vid = getVisitorId();
      const dailyFolder = getDailyDateFolder();

      let userIp = "unknown";
      try {
        const ipRes = await fetch("https://api.ipify.org?format=json");
        const ipData = await ipRes.json();
        userIp = ipData.ip;
      } catch (err) {
        // ignore
      }

      let deviceData = {
        vendor: "Unknown",
        model: "Unknown",
        os: "Unknown",
        browser: "Unknown",
        type: "Unknown",
      };
      try {
        const parser = new UAParser();
        const result = parser.getResult();
        deviceData = {
          vendor: result.device.vendor || "Unknown",
          model: result.device.model || "Unknown",
          type: result.device.type || "desktop",
          os: result.os.name
            ? `${result.os.name} ${result.os.version || ""}`.trim()
            : "Unknown",
          browser: result.browser.name
            ? `${result.browser.name} ${result.browser.version || ""}`.trim()
            : "Unknown",
        };
      } catch (err) {
        // ignore
      }

      try {
        const docRef = doc(db, "user_searches", dailyFolder, "visitors", vid);
        await setDoc(
          docRef,
          {
            visitor_id: vid,
            ip: userIp,
            device: deviceData,
            last_visited_at: serverTimestamp(),
          },
          { merge: true },
        );
      } catch (e) {
        console.warn("Could not log daily visit to Firestore:", e);
      }
    };
    logVisit();
  }, []);

  useEffect(() => {
    const targets = document.querySelectorAll(".reveal-on-scroll");
    if (!targets.length) {
      return undefined;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-visible");
          }
        });
      },
      {
        threshold: 0.08,
        rootMargin: "0px 0px 14% 0px",
      },
    );

    targets.forEach((node) => observer.observe(node));

    return () => {
      observer.disconnect();
    };
  }, [analysis, showReportPage, coachReport]);

  useEffect(() => {
    if (!showReportPage || coachLoading || coachError) {
      return;
    }

    const reportTargets = document.querySelectorAll(
      ".report-page .reveal-on-scroll",
    );
    reportTargets.forEach((node) => node.classList.add("is-visible"));
  }, [showReportPage, coachLoading, coachError, coachReport]);

  useEffect(() => {
    setProfileForm({
      name: profile?.name || currentUser?.displayName || "",
      email: profile?.email || currentUser?.email || "",
      age:
        profile?.age === null || profile?.age === undefined
          ? ""
          : String(profile.age),
      location: profile?.location || "",
      bio: profile?.bio || "",
    });
  }, [profile, currentUser]);

  useEffect(() => {
    if (!showProfileMenu) {
      return undefined;
    }

    const onClickOutside = (event) => {
      if (
        profileMenuRef.current &&
        !profileMenuRef.current.contains(event.target)
      ) {
        setShowProfileMenu(false);
      }
    };

    document.addEventListener("mousedown", onClickOutside);
    return () => {
      document.removeEventListener("mousedown", onClickOutside);
    };
  }, [showProfileMenu]);

  const openProfilePage = async () => {
    if (!currentUser) {
      setShowAuthModal(true);
      return;
    }

    setShowProfileMenu(false);
    setShowProfilePage(true);
    setShowCreditsPage(false);
    setShowReportPage(false);
    setProfileError("");
    setProfileSavedMessage("");
    setPurchaseMessage("");

    try {
      setProfileLoading(true);
      await refreshProfile();
    } catch (err) {
      setProfileError(err.message || "Unable to load profile.");
    } finally {
      setProfileLoading(false);
    }
  };

  const openCreditsPage = async () => {
    if (!currentUser) {
      setShowAuthModal(true);
      return;
    }

    setShowProfileMenu(false);
    setShowCreditsPage(true);
    setShowProfilePage(false);
    setShowReportPage(false);
    setPurchaseMessage("");
    setPurchaseError("");

    try {
      setProfileLoading(true);
      await refreshProfile();
    } catch (err) {
      setPurchaseError(err.message || "Unable to load credits.");
    } finally {
      setProfileLoading(false);
    }
  };

  const handleProfileInput = (event) => {
    const { name, value } = event.target;
    setProfileForm((prev) => ({
      ...prev,
      [name]: value,
    }));
  };

  const handleSaveProfile = async (event) => {
    event.preventDefault();
    setProfileError("");
    setProfileSavedMessage("");

    try {
      setProfileLoading(true);
      await saveProfile({
        name: profileForm.name,
        email: profileForm.email,
        age: profileForm.age === "" ? "" : Number(profileForm.age),
        location: profileForm.location,
        bio: profileForm.bio,
      });
      setProfileSavedMessage("Profile saved successfully.");
    } catch (err) {
      setProfileError(err.message || "Unable to save profile.");
    } finally {
      setProfileLoading(false);
    }
  };

  const handlePurchaseCredits = async (packageKey) => {
    setPurchaseError("");
    setPurchaseMessage("");
    setPurchaseLoadingKey(packageKey);

    try {
      const result = await purchaseCredits(packageKey);
      setPurchaseMessage(
        `Added ${result.addedCredits} credits successfully. New balance: ${result.credits}.`,
      );
    } catch (err) {
      setPurchaseError(err.message || "Unable to add credits.");
    } finally {
      setPurchaseLoadingKey("");
    }
  };

  const handleAnalyze = async (event) => {
    event.preventDefault();
    const trimmed = username.trim();

    if (!trimmed) {
      setError("Please paste or type your LeetCode username.");
      return;
    }

    setLoading(true);
    setError("");
    setCoachError("");

    try {
      try {
        const vid = getVisitorId();
        const dailyFolder = getDailyDateFolder();

        await addDoc(
          collection(
            db,
            "user_searches",
            dailyFolder,
            "visitors",
            vid,
            "searches",
          ),
          {
            username: trimmed,
            timestamp: serverTimestamp(),
          },
        );
      } catch (err) {
        console.error("Error saving user to Firestore:", err);
        alert(
          "Firestore Error: Data didn't save.\n\n" +
            "Reason: " +
            err.message +
            "\n\n" +
            "Fix: In your Firebase Console, ensure 'Firestore Database' is created and your Rules are set to allow read/writes!",
        );
      }

      const response = await fetch(
        toApiUrl(`/api/analyze?username=${encodeURIComponent(trimmed)}`),
      );
      const data = await readApiPayload(response);

      if (!response.ok) {
        const message = buildHttpErrorMessage(
          response,
          data,
          "Failed to analyze username.",
        );
        throw new Error(message);
      }

      setAnalysis(data);
      const cache = loadReportCache();
      const cacheKey = data.username ? data.username.toLowerCase() : "";
      const saved = cacheKey ? cache[cacheKey] : null;

      if (saved?.report) {
        setCoachReport(saved.report);
        setCoachSavedAt(saved.savedAt || "");
      } else {
        setCoachReport("");
        setCoachSavedAt("");
      }

      setShowAllTopics(false);
      setShowReportPage(false);
    } catch (fetchError) {
      setAnalysis(null);
      setError(fetchError.message || "Unable to fetch LeetCode stats.");
    } finally {
      setLoading(false);
    }
  };

  const formatPercent = (value) => `${value.toFixed(1)}%`;

  const openSavedCoachReport = () => {
    if (!currentUser) {
      setShowAuthModal(true);
      return;
    }

    const trimmed = username.trim();
    if (!trimmed) {
      setCoachError("Please enter a username first.");
      return;
    }

    const cacheKey = trimmed.toLowerCase();
    const cache = loadReportCache();
    const saved = cache[cacheKey];

    if (!saved?.report) {
      setCoachError(
        "No saved AI evaluation found for this username. Generate a new report.",
      );
      return;
    }

    setCoachError("");
    setCoachReport(saved.report);
    setCoachSavedAt(saved.savedAt || "");
    setShowReportPage(true);
  };

  const handleGenerateCoachReport = async () => {
    if (currentUser && credits <= 0) {
      setCoachError("You have no credits remaining.");
      setShowOutOfCreditsModal(true);
      return;
    }

    const trimmed = username.trim();
    if (!trimmed) {
      setCoachError("Please enter a username first.");
      return;
    }

    const cacheKey = trimmed.toLowerCase();
    const cache = loadReportCache();

    setCoachLoading(true);
    setCoachError("");
    setShowReportPage(true);

    try {
      const headers = { "Content-Type": "application/json" };
      if (currentUser) {
        const token = await currentUser.getIdToken();
        headers.Authorization = `Bearer ${token}`;
      }

      const response = await fetch(toApiUrl("/api/coach"), {
        method: "POST",
        headers,
        body: JSON.stringify({ username: trimmed }),
      });

      const data = await readApiPayload(response);
      if (!response.ok) {
        throw new Error(
          buildHttpErrorMessage(
            response,
            data,
            "Unable to generate AI report.",
          ),
        );
      }

      setCoachReport(data.report || "");
      const savedAt = new Date().toISOString();
      cache[cacheKey] = {
        report: data.report || "",
        savedAt,
      };
      saveReportCache(cache);
      setCoachSavedAt(savedAt);

      await refreshCredits();
    } catch (coachFetchError) {
      setCoachReport("");
      setCoachError(
        coachFetchError.message || "Unable to generate AI report right now.",
      );
    } finally {
      setCoachLoading(false);
    }
  };

  const difficultyCards =
    analysis && analysis.difficulty
      ? [
          {
            key: "easy",
            label: "Easy",
            className: "easy",
            data: analysis.difficulty.easy || 0,
          },
          {
            key: "medium",
            label: "Medium",
            className: "medium",
            data: analysis.difficulty.medium || 0,
          },
          {
            key: "hard",
            label: "Hard",
            className: "hard",
            data: analysis.difficulty.hard || 0,
          },
        ]
      : [];

  const visibleTopics =
    analysis && analysis.topics
      ? showAllTopics
        ? analysis.topics
        : analysis.topics.slice(0, 3)
      : [];

  const topicTableRows =
    analysis && analysis.topics ? analysis.topics.slice(0, 10) : [];
  const heatmapData = analysis?.recentActivity?.dailyHeatmap || [];
  const maxHeatCount = heatmapData.reduce(
    (max, point) => Math.max(max, point.count),
    0,
  );
  const monthTicks = getMonthTicks(heatmapData);
  const ringProgress =
    analysis && analysis.totals
      ? (analysis.totals.solved / Math.max(analysis.totals.questions, 1)) * 100
      : 0;
  const topicGraphRows = analysis
    ? showAllTopics
      ? analysis.topics.slice(0, 20)
      : analysis.topics.slice(0, 8)
    : [];

  const reportSections = parseReportSections(coachReport);
  const displaySections = reportSections.filter(s => normalizeSectionTitle(s.title) !== "evaluation report" && normalizeSectionTitle(s.title) !== "overall skill score");
  const scoreValue = extractScore(coachReport);
  const hasSavedReport = Boolean(coachReport);

  return (
    <main className="container">
      <header
        className="brand-row"
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <div style={{ display: "flex", alignItems: "center" }}>
          <img src="/logo.png" alt="LeetLens logo" className="brand-logo" />
          <h1 className="brand-wordmark">
            <span className="leet">Leet</span>
            <span className="lens">Lens</span>
          </h1>
        </div>
        <div>
          {currentUser ? (
            <div className="profile-menu-wrap" ref={profileMenuRef}>
              <button
                type="button"
                className="profile-icon-btn"
                onClick={() => setShowProfileMenu((value) => !value)}
                title="Open profile menu"
              >
                {profile?.photoURL || currentUser?.photoURL ? (
                  <img
                    src={profile?.photoURL || currentUser?.photoURL}
                    alt="Profile"
                    className="profile-avatar"
                  />
                ) : (
                  <span className="profile-initials">
                    {getUserInitials(currentUser, profile)}
                  </span>
                )}
              </button>

              {showProfileMenu ? (
                <div className="profile-dropdown">
                  <button type="button" onClick={openProfilePage}>
                    Profile
                  </button>
                  <button type="button" onClick={openCreditsPage}>
                    Credits
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setShowProfileMenu(false);
                      logout();
                    }}
                  >
                    Log Out
                  </button>
                </div>
              ) : null}
            </div>
          ) : (
            <button
              onClick={() => setShowAuthModal(true)}
              style={{
                backgroundColor: "#3b82f6",
                color: "#fff",
                border: "none",
                padding: "8px 20px",
                borderRadius: "5px",
                cursor: "pointer",
                fontWeight: "bold",
              }}
            >
              Log In
            </button>
          )}
        </div>
      </header>
      <p className="subtitle">
        Track your problem solving progress and trends.
      </p>

      {showProfilePage ? (
        <section className="card profile-page">
          <div className="profile-page-header">
            <h2>Your Profile</h2>
            <button
              type="button"
              className="close-report"
              onClick={() => setShowProfilePage(false)}
            >
              Close
            </button>
          </div>

          <form className="profile-form" onSubmit={handleSaveProfile}>
            <label>
              Name
              <input
                type="text"
                name="name"
                value={profileForm.name}
                onChange={handleProfileInput}
                placeholder="Your full name"
              />
            </label>

            <label>
              Email
              <input
                type="email"
                name="email"
                value={profileForm.email}
                onChange={handleProfileInput}
                placeholder="Your email"
              />
            </label>

            <label>
              Age
              <input
                type="number"
                name="age"
                min="0"
                max="120"
                value={profileForm.age}
                onChange={handleProfileInput}
                placeholder="Your age"
              />
            </label>

            <label>
              Location
              <input
                type="text"
                name="location"
                value={profileForm.location}
                onChange={handleProfileInput}
                placeholder="City, Country"
              />
            </label>

            <label>
              Bio
              <textarea
                name="bio"
                rows="4"
                value={profileForm.bio}
                onChange={handleProfileInput}
                placeholder="Tell us about yourself"
              />
            </label>

            <div className="profile-actions">
              <button type="submit" disabled={profileLoading}>
                {profileLoading ? "Saving..." : "Save Profile"}
              </button>
            </div>
          </form>

          {profileError ? <p className="error">{profileError}</p> : null}
          {profileSavedMessage ? (
            <p className="saved-note">{profileSavedMessage}</p>
          ) : null}
        </section>
      ) : null}

      {showCreditsPage ? (
        <section className="card profile-page">
          <div className="profile-page-header">
            <h2>Credits</h2>
            <button
              type="button"
              className="close-report"
              onClick={() => setShowCreditsPage(false)}
            >
              Close
            </button>
          </div>

          <section className="credits-section">
            <p className="credits-note">Current balance: {credits} credits</p>
            <div className="credits-pack-grid">
              <button
                type="button"
                className="credit-pack-btn"
                disabled={purchaseLoadingKey !== ""}
                onClick={() => handlePurchaseCredits("50_rs9")}
              >
                {purchaseLoadingKey === "50_rs9"
                  ? "Adding..."
                  : "50 Credits - Rs. 9"}
              </button>
              <button
                type="button"
                className="credit-pack-btn"
                disabled={purchaseLoadingKey !== ""}
                onClick={() => handlePurchaseCredits("150_rs19")}
              >
                {purchaseLoadingKey === "150_rs19"
                  ? "Adding..."
                  : "150 Credits - Rs. 19"}
              </button>
              <button
                type="button"
                className="credit-pack-btn"
                disabled={purchaseLoadingKey !== ""}
                onClick={() => handlePurchaseCredits("400_rs29")}
              >
                {purchaseLoadingKey === "400_rs29"
                  ? "Adding..."
                  : "400 Credits - Rs. 29"}
              </button>
            </div>
          </section>

          {purchaseError ? <p className="error">{purchaseError}</p> : null}
          {purchaseMessage ? (
            <p className="saved-note">{purchaseMessage}</p>
          ) : null}
        </section>
      ) : null}

      <section className="card analyze-card">
        <h2>Analyze LeetCode Profile</h2>
        <form className="analyze-form" onSubmit={handleAnalyze}>
          <input
            type="text"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            placeholder="Paste or type your LeetCode username"
          />
          <button type="submit" disabled={loading}>
            {loading ? "Analyzing..." : "Analyze"}
          </button>
        </form>
        {error ? <p className="error">{error}</p> : null}
      </section>

      {analysis ? (
        <>
          <section className="dashboard-grid">
            <article className="dashboard-card solved-card reveal-on-scroll">
              <div className="ring-wrap">
                <svg viewBox="0 0 120 120" className="progress-ring">
                  <circle cx="60" cy="60" r="52" className="ring-track" />
                  <circle
                    cx="60"
                    cy="60"
                    r="52"
                    className="ring-progress"
                    style={{
                      strokeDasharray: `${(ringProgress / 100) * 327} 327`,
                    }}
                  />
                </svg>
                <div className="ring-center">
                  <h3>
                    {analysis.totals.solved}
                    <span>/{analysis.totals.questions}</span>
                  </h3>
                  <p>Solved</p>
                  <small>{analysis.totals.attempting} Attempting</small>
                </div>
              </div>

              <div className="difficulty-pills">
                {difficultyCards.map((item) => (
                  <article
                    key={item.key}
                    className={`difficulty-pill ${item.className}`}
                  >
                    <h3>{item.label}</h3>
                    <p>
                      {item.data.solved}/{item.data.total}
                    </p>
                  </article>
                ))}
              </div>
            </article>

            <article className="dashboard-card badge-card reveal-on-scroll">
              <h3>Badges</h3>
              <p className="badge-count">0</p>
              <p className="badge-note">Locked Badge</p>
              <h4>Apr LeetCoding Challenge</h4>
            </article>

            <article className="dashboard-card activity-card reveal-on-scroll">
              <div className="activity-head">
                <h3>
                  {analysis.recentActivity.last30DaysSubmissions} submissions in
                  the past 30 days
                </h3>
                <p>
                  Total active days:{" "}
                  {Math.min(365, heatmapData.filter((d) => d.count > 0).length)}
                  <span> | Max streak: {analysis.recentActivity.streak}</span>
                </p>
              </div>

              <div className="heatmap-grid year-grid">
                {heatmapData.map((point) => {
                  const level = getHeatLevel(point.count, maxHeatCount);
                  return (
                    <span
                      key={`year-heat-${point.date}`}
                      className={`heat-cell level-${level}`}
                      title={`${point.date}: ${point.count} submissions`}
                    />
                  );
                })}
              </div>

              <div className="month-ticks">
                {monthTicks.map((tick) => (
                  <span
                    key={`tick-${tick.month}-${tick.index}`}
                    style={{
                      left: `${(tick.index / Math.max(heatmapData.length - 1, 1)) * 100}%`,
                    }}
                  >
                    {tick.month}
                  </span>
                ))}
              </div>
            </article>
          </section>

          <section className="card topic-dark reveal-on-scroll">
            <h2>Topic Coverage</h2>
            <p className="topics-note">
              Topic breakdown graph with color-coded coverage.
            </p>

            <div className="topic-graph-list">
              {topicGraphRows.map((topic, index) => (
                <div key={`graph-${topic.name}`} className="topic-graph-row">
                  <div className="topic-graph-head">
                    <span>{topic.name}</span>
                    <span>
                      {topic.solved} ({formatPercent(topic.percentage)})
                    </span>
                  </div>
                  <div className="topic-graph-track">
                    <div
                      className="topic-graph-fill"
                      style={{
                        width: `${Math.min(topic.percentage, 100)}%`,
                        background: getTopicColor(index),
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>

            {analysis.topics.length > 3 ? (
              <button
                type="button"
                className="topic-toggle"
                onClick={() => setShowAllTopics((value) => !value)}
              >
                {showAllTopics ? "Show Less" : "Expand All"}
              </button>
            ) : null}
          </section>

          <section className="card coach-card reveal-on-scroll">
            <h2>AI Coach Evaluation</h2>
            <p className="topics-note">
              Get a hiring-oriented evaluation with strengths, weaknesses, and a
              7-day plan.
            </p>

            {coachSavedAt ? (
              <p className="saved-note">
                Saved report available for this username.
              </p>
            ) : null}

            <div className="coach-actions">
              {hasSavedReport ? (
                <button
                  type="button"
                  className="coach-button coach-button-secondary"
                  onClick={openSavedCoachReport}
                  disabled={coachLoading}
                >
                  Open Saved AI Evaluation
                </button>
              ) : null}

              <button
                type="button"
                className="coach-button"
                onClick={handleGenerateCoachReport}
                disabled={coachLoading}
              >
                {coachLoading ? "Generating Report..." : "Generate New Report"}
              </button>
            </div>
          </section>
        </>
      ) : null}

      {showReportPage ? (
        <section className="report-page">
          <div className="report-header">
            <h2>AI Evaluation Report</h2>
            <button
              type="button"
              className="close-report"
              onClick={() => setShowReportPage(false)}
            >
              Back
            </button>
          </div>

          {coachLoading ? (
            <div className="report-loader-wrap">
              <div className="loader" />
              <h3>Generating AI report...</h3>
              <p>
                Building current insights and future plans for your profile.
              </p>
            </div>
          ) : null}

          {!coachLoading && coachError ? (
            <p className="error">{coachError}</p>
          ) : null}

          {!coachLoading && !coachError && reportSections.length > 0 ? (
            <>
              <article className="report-score-card reveal-on-scroll">
                <div className="report-score-badge">
                  <span className="score-value">{!currentUser ? "XX" : (scoreValue ?? "--")}</span>
                  <span className="score-max">/100</span>
                </div>
                  <div className="report-score-copy">
                    <h3>Overall Skill Score</h3>
                    <p>
                      Snapshot of your interview readiness based on topic depth,
                      difficulty handling, and contest profile.
                    </p>
                  </div>
                </article>

              <div className="report-sections" style={{ position: "relative" }}>
                {displaySections.map((section, index) => {
                  const norm = normalizeSectionTitle(section.title);
                  const isReadiness = norm.includes("company readiness");
                  const isTopicBreakdown = norm.includes("topic breakdown");
                  const tone = getSectionTone(section.title);
                  const isInsights = tone === "insights";

                  const isBlurred = !currentUser && index > 1;
                  const fadeOutItemsAfter = (!currentUser && index <= 1) ? 2 : Infinity;

                  return (
                    <article
                      key={`${section.title}-${index}`}
                      className={`report-section reveal-on-scroll ${isReadiness ? "readiness" : ""} ${isInsights ? "featured" : ""} ${isBlurred ? "unauth-faded" : ""}`}
                    >
                      <h3 className={`section-title section-title-${tone}`}>
                        <span className="section-label">Section {index + 1}</span>
                        {section.title}
                      </h3>
                      {isReadiness ? (
                        <div className="section-row-list">
                          {(() => {
                            const readinessRows = pairReadinessItems(section.items);
                            const avgReadiness = getAverageReadiness(readinessRows);
                            return (
                              <>
                                {avgReadiness !== null ? (
                                  <div className={`readiness-average ${isBlurred ? "unauth-faded" : ""}`}>
                                    <span className="readiness-average-label">
                                      Average Readiness
                                    </span>
                                    <span className="readiness-score-pill">
                                      {avgReadiness}
                                      <small>/100</small>
                                    </span>
                                  </div>
                                ) : null}
                                {readinessRows.map((row, rIndex) => {
                                  const parsed = parseReadinessHeading(row.heading);
                                  return (
                                    <article
                                      key={`readiness-${rIndex}`}
                                      className={`section-item-card ${rIndex >= fadeOutItemsAfter || isBlurred ? "unauth-faded" : ""}`}
                                      style={{ "--item-index": rIndex }}
                                    >
                                      <div className="section-item-headline">
                                        <p className="section-item-heading">
                                          {renderLineWithHighlights(parsed.label)}
                                        </p>
                                        {parsed.score !== null ? (
                                          <span className="readiness-score-pill">
                                            {parsed.score}
                                            <small>/100</small>
                                          </span>
                                        ) : null}
                                      </div>
                                      {row.details ? (
                                        <p className="section-item-details">
                                          {renderLineWithHighlights(row.details)}
                                        </p>
                                      ) : null}
                                    </article>
                                  );
                                })}
                              </>
                            );
                          })()}
                        </div>
                      ) : isTopicBreakdown ? (
                        <div className="section-row-list">
                          {pairHeadingDetailItems(section.items).map((row, rIndex) => (
                            <article
                              key={`${section.title}-row-${rIndex}`}
                              className={`section-item-card ${rIndex >= fadeOutItemsAfter || isBlurred ? "unauth-faded" : ""}`}
                              style={{ "--item-index": rIndex }}
                            >
                              <p className="section-item-heading">
                                {renderLineWithHighlights(stripTrailingColon(row.heading))}
                              </p>
                              {row.details ? (
                                <p className="section-item-details">
                                  {renderLineWithHighlights(row.details)}
                                </p>
                              ) : null}
                            </article>
                          ))}
                        </div>
                      ) : (
                        <ul>
                          {section.items.map((item, iIndex) => (
                            <li 
                              key={`${section.title}-${iIndex}`} 
                              style={{ "--item-index": iIndex }}
                              className={iIndex >= fadeOutItemsAfter || isBlurred ? "unauth-faded" : ""}
                            >
                              {renderLineWithHighlights(item)}
                            </li>
                          ))}
                        </ul>
                      )}
                    </article>
                  );
                })}

                {displaySections.length === 0 && Array.isArray(reportSections) && reportSections.length > 0 ? (
                  <article className="report-section" style={{ minHeight: "300px", whiteSpace: "pre-wrap", color: "#cbd5e1" }}>
                    <h3 className="section-title">Raw AI Evaluation</h3>
                    {coachReport}
                  </article>
                ) : null}

                {!currentUser && (
                  <div className="paywall-overlay">
                    <button className="paywall-btn" onClick={() => setShowAuthModal(true)}>
                      Login to Unlock Full AI Report
                    </button>
                  </div>
                )}
              </div>
            </>
          ) : null}
        </section>
      ) : null}

      {showAuthModal && <AuthModal onClose={() => setShowAuthModal(false)} />}

      {showOutOfCreditsModal ? (
        <div
          className="modal-overlay"
          onClick={() => setShowOutOfCreditsModal(false)}
        >
          <div
            className="credit-modal"
            onClick={(event) => event.stopPropagation()}
          >
            <h3>Out of Credits</h3>
            <p>
              You have no credits left. Please contact admin to add more
              credits.
            </p>
            <button
              type="button"
              className="coach-button"
              onClick={() => setShowOutOfCreditsModal(false)}
            >
              Okay
            </button>
          </div>
        </div>
      ) : null}
    </main>
  );
}

export default App;
