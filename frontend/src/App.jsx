import { useEffect, useState, useRef } from "react";
import { UAParser } from "ua-parser-js";
import "./App.css";
import { db } from "./firebase";
import { collection, addDoc, doc, setDoc, serverTimestamp } from "firebase/firestore";

function getDailyDateFolder() {
  const d = new Date();
  const day = d.getDate();
  const monthNames = ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"];
  const month = monthNames[d.getMonth()];
  const year = d.getFullYear();
  return `${day} ${month} ${year}`;
}

function getVisitorId() {
  let vid = localStorage.getItem("leetlens_visitor_id");
  if (!vid) {
    vid = typeof crypto !== 'undefined' && crypto.randomUUID 
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

  lines.forEach((line) => {
    const headingMatch = line.match(/^\d+\.\s+\*{0,2}(.+?)\*{0,2}:?$/);
    if (headingMatch) {
      current = {
        title: headingMatch[1],
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

    current.items.push(line.replace(/^[-*]\s*/, ""));
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

function extractScore(scoreSection) {
  if (!scoreSection) {
    return null;
  }

  const allText = scoreSection.items.join(" ");
  const match = allText.match(/\b(\d{1,3})\b/);
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
  const tokens = line.split(
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
  const hasLoggedVisit = useRef(false);

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

      let deviceData = { vendor: "Unknown", model: "Unknown", os: "Unknown", browser: "Unknown", type: "Unknown" };
      try {
        const parser = new UAParser();
        const result = parser.getResult();
        deviceData = {
          vendor: result.device.vendor || "Unknown",
          model: result.device.model || "Unknown",
          type: result.device.type || "desktop",
          os: result.os.name ? `${result.os.name} ${result.os.version || ""}`.trim() : "Unknown",
          browser: result.browser.name ? `${result.browser.name} ${result.browser.version || ""}`.trim() : "Unknown",
        };
      } catch (err) {
        // ignore
      }

      try {
        const docRef = doc(db, "user_searches", dailyFolder, "visitors", vid);
        await setDoc(docRef, {
          visitor_id: vid,
          ip: userIp,
          device: deviceData,
          last_visited_at: serverTimestamp()
        }, { merge: true });
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
        
        await addDoc(collection(db, "user_searches", dailyFolder, "visitors", vid, "searches"), {
          username: trimmed,
          timestamp: serverTimestamp()
        });
      } catch (err) {
        console.error("Error saving user to Firestore:", err);
        alert("Firestore Error: Data didn't save.\n\n" + 
              "Reason: " + err.message + "\n\n" +
              "Fix: In your Firebase Console, ensure 'Firestore Database' is created and your Rules are set to allow read/writes!");
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

  const handleCoachReport = async () => {
    const trimmed = username.trim();
    if (!trimmed) {
      setCoachError("Please enter a username first.");
      return;
    }

    const cacheKey = trimmed.toLowerCase();
    const cache = loadReportCache();
    const saved = cache[cacheKey];

    if (saved?.report) {
      setCoachError("");
      setCoachReport(saved.report);
      setCoachSavedAt(saved.savedAt || "");
      setShowReportPage(true);
      return;
    }

    setCoachLoading(true);
    setCoachError("");
    setCoachReport("");
    setCoachSavedAt("");
    setShowReportPage(true);

    try {
      const response = await fetch(toApiUrl("/api/coach"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
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
  const scoreSection = findSection(reportSections, "overall skill score");
  const insightsSection = findSection(reportSections, "current insights");
  const readinessSection = findSection(reportSections, "company readiness");
  const scoreValue = extractScore(scoreSection);
  const remainingSections = reportSections.filter(
    (section) =>
      section !== scoreSection &&
      section !== insightsSection &&
      section !== readinessSection,
  );

  return (
    <main className="container">
      <header className="brand-row">
        <img src="/logo.png" alt="LeetLens logo" className="brand-logo" />
        <h1 className="brand-wordmark">
          <span className="leet">Leet</span>
          <span className="lens">Lens</span>
        </h1>
      </header>
      <p className="subtitle">
        Track your problem solving progress and trends.
      </p>

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

            <button
              type="button"
              className="coach-button"
              onClick={handleCoachReport}
              disabled={coachLoading}
            >
              {coachLoading
                ? "Generating Report..."
                : coachReport
                  ? "Open Saved AI Evaluation"
                  : "Generate AI Evaluation"}
            </button>
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
              {scoreSection ? (
                <article className="report-score-card reveal-on-scroll">
                  <div className="report-score-badge">
                    <span className="score-value">{scoreValue ?? "--"}</span>
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
              ) : null}

              <div className="report-priority-grid">
                {insightsSection ? (
                  <article className="report-section featured reveal-on-scroll">
                    <h3 className="section-title section-title-insights">
                      Current Insights
                    </h3>
                    <ul>
                      {insightsSection.items.map((item, index) => (
                        <li
                          key={`insights-${index}`}
                          style={{ "--item-index": index }}
                        >
                          {renderLineWithHighlights(item)}
                        </li>
                      ))}
                    </ul>
                  </article>
                ) : null}

                {readinessSection ? (
                  <article className="report-section featured readiness reveal-on-scroll">
                    <h3 className="section-title section-title-readiness">
                      Company Readiness (%)
                    </h3>
                    {(() => {
                      const readinessRows = pairReadinessItems(
                        readinessSection.items,
                      );
                      const avgReadiness = getAverageReadiness(readinessRows);

                      return (
                        <>
                          {avgReadiness !== null ? (
                            <div className="readiness-average">
                              <span className="readiness-average-label">
                                Average Readiness
                              </span>
                              <span className="readiness-score-pill">
                                {avgReadiness}
                                <small>/100</small>
                              </span>
                            </div>
                          ) : null}

                          <div className="section-row-list">
                            {readinessRows.map((row, index) => {
                              const parsed = parseReadinessHeading(row.heading);
                              return (
                                <article
                                  key={`readiness-${index}`}
                                  className="section-item-card"
                                  style={{ "--item-index": index }}
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
                          </div>
                        </>
                      );
                    })()}
                  </article>
                ) : null}
              </div>

              <div className="report-sections">
                {remainingSections.map((section) => (
                  <article
                    key={section.title}
                    className="report-section reveal-on-scroll"
                  >
                    <h3
                      className={`section-title section-title-${getSectionTone(section.title)}`}
                    >
                      {section.title}
                    </h3>
                    {normalizeSectionTitle(section.title).includes(
                      "topic breakdown",
                    ) ? (
                      <div className="section-row-list">
                        {pairHeadingDetailItems(section.items).map(
                          (row, index) => (
                            <article
                              key={`${section.title}-row-${index}`}
                              className="section-item-card"
                              style={{ "--item-index": index }}
                            >
                              <p className="section-item-heading">
                                {renderLineWithHighlights(
                                  stripTrailingColon(row.heading),
                                )}
                              </p>
                              {row.details ? (
                                <p className="section-item-details">
                                  {renderLineWithHighlights(row.details)}
                                </p>
                              ) : null}
                            </article>
                          ),
                        )}
                      </div>
                    ) : (
                      <ul>
                        {section.items.map((item, index) => (
                          <li
                            key={`${section.title}-${index}`}
                            style={{ "--item-index": index }}
                          >
                            {renderLineWithHighlights(item)}
                          </li>
                        ))}
                      </ul>
                    )}
                  </article>
                ))}
              </div>
            </>
          ) : null}
        </section>
      ) : null}
    </main>
  );
}

export default App;
