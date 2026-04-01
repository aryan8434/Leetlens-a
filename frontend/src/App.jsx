import { useState } from "react";
import "./App.css";

const REPORT_CACHE_KEY = "leetlensCoachReports";

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
  return (title || "")
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
      const response = await fetch(
        `/api/analyze?username=${encodeURIComponent(trimmed)}`,
      );
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Failed to analyze username.");
      }

      setAnalysis(data);
      const cache = loadReportCache();
      const cacheKey = data.username.toLowerCase();
      const saved = cache[cacheKey];

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
      const response = await fetch("/api/coach", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ username: trimmed }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Unable to generate AI report.");
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

  const difficultyCards = analysis
    ? [
        {
          key: "easy",
          label: "Easy",
          className: "easy",
          data: analysis.difficulty.easy,
        },
        {
          key: "medium",
          label: "Medium",
          className: "medium",
          data: analysis.difficulty.medium,
        },
        {
          key: "hard",
          label: "Hard",
          className: "hard",
          data: analysis.difficulty.hard,
        },
      ]
    : [];

  const visibleTopics = analysis
    ? showAllTopics
      ? analysis.topics
      : analysis.topics.slice(0, 3)
    : [];

  const topicTableRows = analysis ? analysis.topics.slice(0, 10) : [];
  const heatmapData = analysis?.recentActivity?.dailyHeatmap || [];
  const maxHeatCount = heatmapData.reduce(
    (max, point) => Math.max(max, point.count),
    0,
  );

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

      <section className="card">
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
          <section className="card">
            <h2>
              {analysis.username} - Total Solved: {analysis.totals.solved} /{" "}
              {analysis.totals.questions}
            </h2>
            <p className="total-percent">
              Overall: {formatPercent(analysis.totals.percentage)}
            </p>

            <div className="difficulty-grid">
              {difficultyCards.map((item) => (
                <article
                  key={item.key}
                  className={`difficulty-card ${item.className}`}
                >
                  <h3>{item.label}</h3>
                  <p className="value">
                    {item.data.solved} / {item.data.total}
                  </p>
                  <p className="percent">
                    {formatPercent(item.data.percentage)}
                  </p>
                </article>
              ))}
            </div>
          </section>

          <section className="card">
            <h2>Topic Coverage</h2>
            <p className="topics-note">
              Percentage is based on your solved problems distribution.
            </p>

            <div className="topics-list">
              {visibleTopics.map((topic) => (
                <div key={topic.name} className="topic-row">
                  <div className="topic-head">
                    <span>{topic.name}</span>
                    <span>
                      {topic.solved} ({formatPercent(topic.percentage)})
                    </span>
                  </div>
                  <div className="topic-track">
                    <div
                      className="topic-fill"
                      style={{ width: `${Math.min(topic.percentage, 100)}%` }}
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
                {showAllTopics ? "Show Top 3" : "Expand All"}
              </button>
            ) : null}

            <div className="topic-table-wrap">
              <h3>Topic Breakdown Table</h3>
              <table className="topic-table">
                <thead>
                  <tr>
                    <th>Topic</th>
                    <th>Solved</th>
                    <th>Coverage</th>
                    <th>Band</th>
                  </tr>
                </thead>
                <tbody>
                  {topicTableRows.map((topic) => (
                    <tr key={`table-${topic.name}`}>
                      <td>{topic.name}</td>
                      <td>{topic.solved}</td>
                      <td>{formatPercent(topic.percentage)}</td>
                      <td>{getTopicBand(topic.percentage)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="heatmap-wrap">
              <h3>Submission Activity Graph</h3>
              <p className="topics-note">
                Last {heatmapData.length} days with LeetCode-style intensity.
              </p>

              <div className="heatmap-grid">
                {heatmapData.map((point) => {
                  const level = getHeatLevel(point.count, maxHeatCount);
                  return (
                    <span
                      key={`heat-${point.date}`}
                      className={`heat-cell level-${level}`}
                      title={`${point.date}: ${point.count} submissions`}
                    />
                  );
                })}
              </div>

              <div className="heatmap-legend">
                <span>Less</span>
                <span className="heat-cell level-0" />
                <span className="heat-cell level-1" />
                <span className="heat-cell level-2" />
                <span className="heat-cell level-3" />
                <span className="heat-cell level-4" />
                <span>More</span>
              </div>
            </div>
          </section>

          <section className="card">
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
                <article className="report-score-card">
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
                  <article className="report-section featured">
                    <h3>Current Insights</h3>
                    <ul>
                      {insightsSection.items.map((item, index) => (
                        <li
                          key={`insights-${index}`}
                          style={{ "--item-index": index }}
                        >
                          {item}
                        </li>
                      ))}
                    </ul>
                  </article>
                ) : null}

                {readinessSection ? (
                  <article className="report-section featured readiness">
                    <h3>Company Readiness (%)</h3>
                    <ul>
                      {readinessSection.items.map((item, index) => (
                        <li
                          key={`readiness-${index}`}
                          style={{ "--item-index": index }}
                        >
                          {item}
                        </li>
                      ))}
                    </ul>
                  </article>
                ) : null}
              </div>

              <div className="report-sections">
                {remainingSections.map((section) => (
                  <article key={section.title} className="report-section">
                    <h3>{section.title}</h3>
                    <ul>
                      {section.items.map((item, index) => (
                        <li
                          key={`${section.title}-${index}`}
                          style={{ "--item-index": index }}
                        >
                          {item}
                        </li>
                      ))}
                    </ul>
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
