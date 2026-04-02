const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const path = require("path");

let admin = null;
try {
  // Firestore logging is optional in local/dev environments.
  // If firebase-admin is unavailable, API endpoints continue to work.
  admin = require("firebase-admin");
} catch (_error) {
  admin = null;
}

dotenv.config({ path: path.join(__dirname, ".env") });

const app = express();
const PORT = process.env.PORT || 5000;
const FRONTEND_BUILD_DIR = path.join(__dirname, "build");
const FRONTEND_DIST_DIR = path.join(__dirname, "dist");
const LEGACY_PUBLIC_DIR = path.join(__dirname, "public");
const LEETCODE_GRAPHQL = "https://leetcode.com/graphql";
const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
const FIRESTORE_USER_SEARCH_COLLECTION = "user_searches";

app.set("trust proxy", true);
app.use(cors());
app.use(express.json());

let firestoreDb = null;

function initFirestore() {
  if (!admin) {
    return null;
  }

  try {
    if (!admin.apps.length) {
      if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
        const serviceAccount = JSON.parse(
          process.env.FIREBASE_SERVICE_ACCOUNT_JSON,
        );
        admin.initializeApp({
          credential: admin.credential.cert(serviceAccount),
        });
      } else if (process.env.NODE_ENV === 'production') {
        // In Cloud Run/Firebase managed runtimes, use attached service account.
        admin.initializeApp();
      } else {
        console.warn("Skipping backend Firestore logging: FIREBASE_SERVICE_ACCOUNT_JSON is not set in `.env`.");
        return null;
      }
    }
    return admin.firestore();
  } catch (error) {
    console.error("Firestore initialization failed:", error.message);
    return null;
  }
}

firestoreDb = initFirestore();

const ANALYZE_QUERY = `
  query userPublicProfile($username: String!) {
    matchedUser(username: $username) {
      username
      profile {
        ranking
        reputation
      }
      submitStatsGlobal {
        acSubmissionNum {
          difficulty
          count
          submissions
        }
      }
      tagProblemCounts {
        advanced {
          tagName
          problemsSolved
        }
        intermediate {
          tagName
          problemsSolved
        }
        fundamental {
          tagName
          problemsSolved
        }
      }
    }
    allQuestionsCount {
      difficulty
      count
    }
  }
`;

const RECENT_SOLVED_QUERY_USER_NODE = `
  query recentAcceptedFromUserNode($username: String!) {
    matchedUser(username: $username) {
      recentAcSubmissionList(limit: 30) {
        title
        titleSlug
        timestamp
      }
    }
  }
`;

const RECENT_SOLVED_QUERY_ROOT = `
  query recentAcceptedFromRoot($username: String!) {
    recentAcSubmissionList(username: $username, limit: 30) {
      title
      titleSlug
      timestamp
    }
  }
`;

const RECENT_SUBMISSIONS_QUERY_ROOT = `
  query recentSubmissionsFromRoot($username: String!) {
    recentSubmissionList(username: $username, limit: 60) {
      title
      titleSlug
      timestamp
      statusDisplay
    }
  }
`;

const CONTEST_QUERY = `
  query userContestData($username: String!) {
    userContestRanking(username: $username) {
      rating
    }
  }
`;

const CALENDAR_QUERY = `
  query userCalendarData($username: String!) {
    matchedUser(username: $username) {
      userCalendar {
        streak
        totalActiveDays
        submissionCalendar
      }
    }
  }
`;

function getDifficultyCount(source, difficulty) {
  const entry = source.find((item) => item.difficulty === difficulty);
  return entry ? entry.count : 0;
}

function toDocSafeId(value) {
  return value.toString().trim().replaceAll("/", "_") || "unknown";
}

function toUsernameDocId(username) {
  return username.toLowerCase().replace(/[^a-z0-9_-]/gi, "_");
}

async function logSearchInFirestore({ username }) {
  if (!firestoreDb) {
    return;
  }

  const now = admin.firestore.FieldValue.serverTimestamp();
  const usernameDocId = toUsernameDocId(username);

  const userSearchRef = firestoreDb
    .collection(FIRESTORE_USER_SEARCH_COLLECTION)
    .doc(usernameDocId);
  const userSearchEventRef = userSearchRef.collection("searches").doc();

  const batch = firestoreDb.batch();

  batch.set(
    userSearchRef,
    {
      username,
      count: admin.firestore.FieldValue.increment(1),
      lastSearchedAt: now,
      firstSearchedAt: now,
    },
    { merge: true },
  );

  batch.set(userSearchEventRef, {
    username,
    searchedAt: now,
  });

  await batch.commit();
}

async function postLeetCodeQuery(username, query) {
  const response = await fetch(LEETCODE_GRAPHQL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Referer: `https://leetcode.com/${username}/`,
    },
    body: JSON.stringify({
      query,
      variables: { username },
    }),
  });

  if (!response.ok) {
    throw new Error("Failed to fetch LeetCode data.");
  }

  const payload = await response.json();
  if (payload.errors?.length) {
    throw new Error(payload.errors[0].message || "LeetCode returned an error.");
  }

  return payload.data;
}

function buildTopicsData(topicSources, totalSolved) {
  const topicMap = new Map();

  ["fundamental", "intermediate", "advanced"].forEach((level) => {
    (topicSources[level] || []).forEach((item) => {
      if (!item.tagName) {
        return;
      }
      const previous = topicMap.get(item.tagName) || 0;
      topicMap.set(item.tagName, previous + (item.problemsSolved || 0));
    });
  });

  return [...topicMap.entries()]
    .map(([name, solvedCount]) => ({
      name,
      solved: solvedCount,
      percentage: totalSolved > 0 ? (solvedCount / totalSolved) * 100 : 0,
    }))
    .sort((a, b) => b.solved - a.solved);
}

function getRecentActivity(calendarData) {
  if (!calendarData?.submissionCalendar) {
    return {
      last30DaysSubmissions: 0,
      streak: 0,
      consistency: "No data",
      dailyHeatmap: [],
    };
  }

  let submissionMap = {};
  try {
    submissionMap = JSON.parse(calendarData.submissionCalendar);
    if (typeof submissionMap === "string") {
      submissionMap = JSON.parse(submissionMap);
    }
  } catch (_error) {
    submissionMap = {};
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const windowStart = nowSec - 30 * 24 * 60 * 60;
  let last30DaysSubmissions = 0;
  let activeDays = 0;

  Object.entries(submissionMap).forEach(([timestamp, count]) => {
    const ts = Number(timestamp);
    if (ts >= windowStart && ts <= nowSec) {
      last30DaysSubmissions += Number(count || 0);
      if (Number(count || 0) > 0) {
        activeDays += 1;
      }
    }
  });

  const consistencyRatio = activeDays / 30;
  let consistency = "Low";
  if (consistencyRatio >= 0.7) {
    consistency = "High";
  } else if (consistencyRatio >= 0.4) {
    consistency = "Medium";
  }

  return {
    last30DaysSubmissions,
    streak: calendarData.streak || 0,
    consistency,
    dailyHeatmap: buildDailyHeatmap(submissionMap, 365),
  };
}

function buildDailyHeatmap(submissionMap, days) {
  const dayCountMap = {};
  Object.entries(submissionMap).forEach(([timestamp, count]) => {
    const d = new Date(Number(timestamp) * 1000);
    const dayKey = d.toISOString().slice(0, 10);
    dayCountMap[dayKey] = (dayCountMap[dayKey] || 0) + Number(count || 0);
  });

  const now = new Date();
  const todayUtc = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );

  const points = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date(todayUtc);
    d.setUTCDate(todayUtc.getUTCDate() - i);
    const dayKey = d.toISOString().slice(0, 10);
    const count = Number(dayCountMap[dayKey] || 0);
    points.push({
      date: dayKey,
      count,
    });
  }

  return points;
}

function buildRecentSolvedProblems(recentAcSubmissionList) {
  return (recentAcSubmissionList || []).map((item) => {
    const ts = Number(item.timestamp || 0);
    return {
      title: item.title || "Unknown Problem",
      titleSlug: item.titleSlug || "",
      solvedAtEpoch: ts,
      solvedAtIso: ts > 0 ? new Date(ts * 1000).toISOString() : null,
      url: item.titleSlug
        ? `https://leetcode.com/problems/${item.titleSlug}/`
        : null,
    };
  });
}

function buildTimingInsights(recentSolvedProblems, last30DaysSubmissions) {
  if (!recentSolvedProblems.length) {
    return {
      avgAcceptedPerDayLast30: 0,
      avgHoursBetweenAccepted: null,
      lastSolvedAtIso: null,
      recentAcceptedCount: 0,
    };
  }

  const solvedWithTime = recentSolvedProblems
    .filter((item) => Number(item.solvedAtEpoch) > 0)
    .sort((a, b) => b.solvedAtEpoch - a.solvedAtEpoch);

  let totalGapSeconds = 0;
  let gapCount = 0;
  for (let i = 0; i < solvedWithTime.length - 1; i += 1) {
    const gap =
      solvedWithTime[i].solvedAtEpoch - solvedWithTime[i + 1].solvedAtEpoch;
    if (gap > 0) {
      totalGapSeconds += gap;
      gapCount += 1;
    }
  }

  const avgHoursBetweenAccepted =
    gapCount > 0
      ? Number((totalGapSeconds / gapCount / 3600).toFixed(2))
      : null;

  return {
    avgAcceptedPerDayLast30: Number((last30DaysSubmissions / 30).toFixed(2)),
    avgHoursBetweenAccepted,
    lastSolvedAtIso: solvedWithTime[0]?.solvedAtIso || null,
    recentAcceptedCount: solvedWithTime.length,
  };
}

function pickRecentAcceptedSubmissions(payload) {
  const fromUserNode = payload?.matchedUser?.recentAcSubmissionList;
  if (Array.isArray(fromUserNode) && fromUserNode.length) {
    return fromUserNode;
  }

  const fromRootAccepted = payload?.recentAcSubmissionList;
  if (Array.isArray(fromRootAccepted) && fromRootAccepted.length) {
    return fromRootAccepted;
  }

  const fromRootRecent = payload?.recentSubmissionList;
  if (Array.isArray(fromRootRecent) && fromRootRecent.length) {
    return fromRootRecent.filter(
      (item) => (item.statusDisplay || "").toLowerCase() === "accepted",
    );
  }

  return [];
}

async function fetchRecentSolvedProblems(username) {
  const candidateQueries = [
    RECENT_SOLVED_QUERY_USER_NODE,
    RECENT_SOLVED_QUERY_ROOT,
    RECENT_SUBMISSIONS_QUERY_ROOT,
  ];

  for (const query of candidateQueries) {
    try {
      const payload = await postLeetCodeQuery(username, query);
      const picked = pickRecentAcceptedSubmissions(payload);
      if (picked.length) {
        return buildRecentSolvedProblems(picked);
      }
    } catch (_error) {
      // LeetCode schema can vary between deployments; fall through to next query shape.
    }
  }

  return [];
}

async function buildAnalysisData(username) {
  const coreData = await postLeetCodeQuery(username, ANALYZE_QUERY);
  const matchedUser = coreData?.matchedUser;

  if (!matchedUser) {
    const notFoundError = new Error("LeetCode username not found.");
    notFoundError.status = 404;
    throw notFoundError;
  }

  const solved = matchedUser.submitStatsGlobal?.acSubmissionNum || [];
  const totals = coreData?.allQuestionsCount || [];

  const totalSolved = getDifficultyCount(solved, "All");
  const totalSubmissions =
    solved.find((item) => item.difficulty === "All")?.submissions || 0;
  const totalQuestions = getDifficultyCount(totals, "All");

  const easySolved = getDifficultyCount(solved, "Easy");
  const mediumSolved = getDifficultyCount(solved, "Medium");
  const hardSolved = getDifficultyCount(solved, "Hard");

  const easyTotal = getDifficultyCount(totals, "Easy");
  const mediumTotal = getDifficultyCount(totals, "Medium");
  const hardTotal = getDifficultyCount(totals, "Hard");

  const topics = buildTopicsData(
    matchedUser.tagProblemCounts || {},
    totalSolved,
  );
  const recentSolvedProblems = await fetchRecentSolvedProblems(username);

  let contestRating = 0;
  try {
    const contestData = await postLeetCodeQuery(username, CONTEST_QUERY);
    contestRating = Number(contestData?.userContestRanking?.rating || 0);
  } catch (_error) {
    contestRating = 0;
  }

  let recentActivity = {
    last30DaysSubmissions: 0,
    streak: 0,
    consistency: "No data",
    dailyHeatmap: [],
  };
  try {
    const calendarData = await postLeetCodeQuery(username, CALENDAR_QUERY);
    recentActivity = getRecentActivity(calendarData?.matchedUser?.userCalendar);
  } catch (_error) {
    recentActivity = {
      last30DaysSubmissions: 0,
      streak: 0,
      consistency: "No data",
      dailyHeatmap: [],
    };
  }

  const timing = buildTimingInsights(
    recentSolvedProblems,
    recentActivity.last30DaysSubmissions,
  );

  return {
    username: matchedUser.username,
    profile: {
      ranking: Number(matchedUser.profile?.ranking || 0),
      reputation: Number(matchedUser.profile?.reputation || 0),
    },
    totals: {
      solved: totalSolved,
      submissions: totalSubmissions,
      attempting: Math.max(totalSubmissions - totalSolved, 0),
      questions: totalQuestions,
      percentage: totalQuestions > 0 ? (totalSolved / totalQuestions) * 100 : 0,
    },
    acceptanceRate:
      totalSubmissions > 0 ? (totalSolved / totalSubmissions) * 100 : 0,
    attemptsPerSolved:
      totalSolved > 0 ? Number((totalSubmissions / totalSolved).toFixed(2)) : 0,
    contestRating,
    recentActivity,
    timing,
    recentSolvedProblems,
    difficulty: {
      easy: {
        solved: easySolved,
        total: easyTotal,
        percentage: easyTotal > 0 ? (easySolved / easyTotal) * 100 : 0,
      },
      medium: {
        solved: mediumSolved,
        total: mediumTotal,
        percentage: mediumTotal > 0 ? (mediumSolved / mediumTotal) * 100 : 0,
      },
      hard: {
        solved: hardSolved,
        total: hardTotal,
        percentage: hardTotal > 0 ? (hardSolved / hardTotal) * 100 : 0,
      },
    },
    topics,
  };
}

function buildCoachPrompt(analysis) {
  const topicSummary = analysis.topics
    .slice(0, 15)
    .map((topic) => `${topic.name}: ${topic.percentage.toFixed(1)}%`)
    .join(", ");

  const recentSubmissionSummary =
    `Last 30 days submissions: ${analysis.recentActivity.last30DaysSubmissions}, ` +
    `streak: ${analysis.recentActivity.streak}, ` +
    `consistency: ${analysis.recentActivity.consistency}`;

  return `You are an expert competitive programming coach and hiring evaluator.

Your task is to analyze a LeetCode user's performance data and generate a detailed, structured evaluation.

INPUT DATA:

* Total solved: ${analysis.totals.solved}

* Easy: ${analysis.difficulty.easy.solved}

* Medium: ${analysis.difficulty.medium.solved}

* Hard: ${analysis.difficulty.hard.solved}

* Acceptance rate: ${analysis.acceptanceRate.toFixed(2)}

* Contest rating: ${analysis.contestRating.toFixed(0)}

* Topic-wise accuracy:
  ${topicSummary || "No topic data"}

* Recent activity:
  ${recentSubmissionSummary}

---

EVALUATION LOGIC:

1. Evaluate topic strength:

* Strong: >70%
* Average: 40-70%
* Weak: <40%

2. Evaluate difficulty handling:

* Strong in Hard if hard problems > 50 solved
* Weak in Hard if < 20 solved

3. Contest evaluation:

* <1400 -> Beginner
* 1400-1800 -> Intermediate
* 1800-2200 -> Strong
* > 2200 -> Elite

---

OUTPUT FORMAT (STRICT):

1. Current Insights:
* Topic coverage summary in one line (percent and key strengths/weaknesses)
* Difficulty distribution summary in one line
* If medium or hard solved count is low, explicitly say: "Try solving more medium and hard questions"

2. Overall Skill Score (0-100):
* Give only final score and a short rationale using topics/difficulty/contest
* Do not show long formulas or arithmetic steps

3. Company Readiness (%):
* Use score out of 100 format, not percent symbol.
* Format exactly like this with each reason on the next line:
  FAANG: <score>/100
  Reason: <one-line reason>
  Product-based: <score>/100
  Reason: <one-line reason>
  Service-based: <score>/100
  Reason: <one-line reason>

4. Topic Breakdown:
* Use heading then next-line details format exactly:
  Strong:
  <comma-separated topics>
  Average:
  <comma-separated topics>
  Weak:
  <comma-separated topics>
* Must mention DP, Graph, Trees explicitly when weak.

5. Key Weaknesses:
* Missing topics
* Hard problem gap
* Consistency gap

6. Improvement Plan (7 days):
* Day 1 to Day 7, each day with topic + target difficulty + target count
* Keep plan practical and specific

7. Final Verdict:
* One line verdict with reason

8. Estimated Time to Reach FAANG Level:
* realistic range with reason

---

IMPORTANT RULES:

* Be honest and realistic (no fake motivation)
* Do NOT give generic advice
* Use the input data strictly
* Keep output structured and clean
* Prioritize actionable insights
* Use exactly numbered headings 1 to 8
* For every subsection, first line must be a heading label and second line must be details.

Return ONLY the structured evaluation.`;
}

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "leetcode-analyzer-api",
    timestamp: new Date().toISOString(),
  });
});

app.get("/api/stats", (_req, res) => {
  res.json({
    solved: 0,
    easy: 0,
    medium: 0,
    hard: 0,
    streak: 0,
  });
});

app.get("/api/analyze", async (req, res) => {
  const username = (req.query.username || "").toString().trim();

  if (!username) {
    return res.status(400).json({ error: "Username is required." });
  }

  try {
    const analysis = await buildAnalysisData(username);

    try {
      await logSearchInFirestore({ username: analysis.username });
    } catch (logError) {
      console.error("Failed to log search in Firestore:", logError.message);
    }

    return res.json(analysis);
  } catch (error) {
    const status = error.status || 500;
    return res.status(status).json({
      error:
        status === 404
          ? "LeetCode username not found."
          : "Unexpected error while analyzing username.",
      details: error.message,
    });
  }
});

app.post("/api/coach", async (req, res) => {
  const username = (req.body?.username || "").toString().trim();

  if (!username) {
    return res.status(400).json({ error: "Username is required." });
  }

  if (!process.env.GROQ_API_KEY) {
    return res.status(400).json({
      error: "Missing GROQ_API_KEY in backend environment.",
    });
  }

  try {
    const analysis = await buildAnalysisData(username);
    const prompt = buildCoachPrompt(analysis);

    const response = await fetch(GROQ_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content:
              "You are an expert competitive programming coach and hiring evaluator. Follow user instructions exactly.",
          },
          {
            role: "user",
            content: prompt,
          },
        ],
      }),
    });

    const payload = await response.json();
    if (!response.ok) {
      return res.status(502).json({
        error: payload.error?.message || "Groq API request failed.",
      });
    }

    const report = payload.choices?.[0]?.message?.content;
    if (!report) {
      return res.status(502).json({
        error: "Groq returned an empty response.",
      });
    }

    return res.json({
      username: analysis.username,
      model: GROQ_MODEL,
      report,
      snapshot: analysis,
    });
  } catch (error) {
    const status = error.status || 500;
    return res.status(status).json({
      error:
        status === 404
          ? "LeetCode username not found."
          : "Unexpected error while generating coach report.",
      details: error.message,
    });
  }
});

const fs = require("fs");
const frontendDir = fs.existsSync(path.join(FRONTEND_BUILD_DIR, "index.html"))
  ? FRONTEND_BUILD_DIR
  : fs.existsSync(path.join(FRONTEND_DIST_DIR, "index.html"))
    ? FRONTEND_DIST_DIR
    : LEGACY_PUBLIC_DIR;

// Keep API misses as JSON instead of accidentally returning the frontend app.
app.use("/api", (_req, res) => {
  res.status(404).json({ error: "API route not found." });
});

// Serve static files from build output.
app.use(express.static(frontendDir));

// SPA fallback: serve index.html for all non-API routes.
app.use((_req, res) => {
  res.sendFile(path.join(frontendDir, "index.html"));
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Frontend directory: ${frontendDir}`);
});
