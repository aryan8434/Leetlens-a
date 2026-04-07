const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const path = require("path");
const fs = require("fs");

let admin = null;
try {
  admin = require("firebase-admin");
} catch (_error) {
  admin = null;
}

dotenv.config({ path: path.join(__dirname, ".env") });

const app = express();
const PORT = Number(process.env.PORT || 5000);
const FRONTEND_BUILD_DIR = path.join(__dirname, "build");
const FRONTEND_DIST_DIR = path.join(__dirname, "dist");
const LEGACY_PUBLIC_DIR = path.join(__dirname, "public");
const LEETCODE_GRAPHQL = "https://leetcode.com/graphql";
const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
const REGISTERED_USERS_COLLECTION = "registered_users";
const FIRESTORE_USER_SEARCH_COLLECTION = "user_searches";
const DEFAULT_USER_CREDITS = 3;
const CREDIT_PACKAGES = {
  "50_rs9": { credits: 50, priceRs: 9 },
  "150_rs19": { credits: 150, priceRs: 19 },
  "400_rs29": { credits: 400, priceRs: 29 },
};

app.set("trust proxy", true);
app.use(cors());
app.use(express.json());

let firestoreDb = null;

function parseServiceAccountFromEnv() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) {
    return null;
  }

  const parsed = JSON.parse(raw);
  if (parsed && typeof parsed.private_key === "string") {
    parsed.private_key = parsed.private_key.replace(/\\n/g, "\n");
  }

  return parsed;
}

function initFirestore() {
  if (!admin) {
    return null;
  }

  try {
    if (!admin.apps.length) {
      if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
        const serviceAccount = parseServiceAccountFromEnv();
        admin.initializeApp({
          credential: admin.credential.cert(serviceAccount),
        });
      } else {
        admin.initializeApp();
      }
    }

    return admin.firestore();
  } catch (error) {
    console.error("Firestore initialization failed:", error.message);
    return null;
  }
}

firestoreDb = initFirestore();

function isAuthSystemReady() {
  return Boolean(admin && firestoreDb);
}

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }

  const realIp = req.headers["x-real-ip"];
  if (typeof realIp === "string" && realIp.trim()) {
    return realIp.trim();
  }

  return req.ip || "unknown";
}

function getBearerToken(req) {
  const authHeader = req.headers.authorization || "";
  if (!authHeader.startsWith("Bearer ")) {
    return "";
  }

  return authHeader.slice(7).trim();
}

async function verifyFirebaseToken(req, res, next) {
  if (!isAuthSystemReady()) {
    return res.status(503).json({
      error: "Authentication service is not configured on the backend.",
    });
  }

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({ error: "Missing Bearer token." });
  }

  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.authUser = decoded;
    return next();
  } catch (_error) {
    return res.status(401).json({ error: "Invalid authentication token." });
  }
}

function getUserRef(uid) {
  return firestoreDb.collection(REGISTERED_USERS_COLLECTION).doc(uid);
}

function toDocSafeId(value) {
  return value.toString().trim().replaceAll("/", "_") || "unknown";
}

function sanitizeProfilePayload(payload) {
  const input = payload || {};
  return {
    name: (input.name || "").toString().trim().slice(0, 80),
    age: Number.isFinite(Number(input.age))
      ? Math.max(0, Math.min(120, Number(input.age)))
      : 0,
    location: (input.location || "").toString().trim().slice(0, 120),
    bio: (input.bio || "").toString().trim().slice(0, 500),
  };
}

function toPublicUserProfile(uid, data, authUser) {
  return {
    uid,
    name: data.name || authUser?.name || "",
    email: data.email || authUser?.email || "",
    age: Number(data.age || 0),
    location: data.location || "",
    bio: data.bio || "",
    ipAddress: data.ipAddress || "",
    credits: Number(data.credits || 0),
  };
}

async function ensureUserDocument(authUser, req) {
  const ref = getUserRef(authUser.uid);
  const snap = await ref.get();
  const now = admin.firestore.FieldValue.serverTimestamp();

  const baseData = {
    email: authUser.email || "",
    name: authUser.name || "",
    age: 0,
    location: "",
    bio: "",
    ipAddress: req ? getClientIp(req) : "",
    updatedAt: now,
  };

  if (!snap.exists) {
    await ref.set({
      ...baseData,
      credits: DEFAULT_USER_CREDITS,
      createdAt: now,
    });
  } else {
    await ref.set(baseData, { merge: true });
  }

  const latest = await ref.get();
  return latest.data() || {};
}

async function consumeOneCredit(uid) {
  const ref = getUserRef(uid);

  return firestoreDb.runTransaction(async (txn) => {
    const snap = await txn.get(ref);
    const data = snap.data() || {};
    const credits = Number(data.credits || 0);

    if (credits <= 0) {
      const noCreditsError = new Error("You have no credits remaining.");
      noCreditsError.status = 402;
      throw noCreditsError;
    }

    const nextCredits = credits - 1;
    txn.set(
      ref,
      {
        credits: nextCredits,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    return nextCredits;
  });
}

async function addCreditsForPackage(uid, packageKey) {
  const pkg = CREDIT_PACKAGES[packageKey];
  if (!pkg) {
    const badPackageError = new Error("Invalid credits package selected.");
    badPackageError.status = 400;
    throw badPackageError;
  }

  const ref = getUserRef(uid);

  return firestoreDb.runTransaction(async (txn) => {
    const snap = await txn.get(ref);
    const data = snap.data() || {};
    const currentCredits = Number(data.credits || 0);
    const nextCredits = currentCredits + pkg.credits;

    txn.set(
      ref,
      {
        credits: nextCredits,
        lastPurchase: {
          packageKey,
          credits: pkg.credits,
          amountRs: pkg.priceRs,
          purchasedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    return {
      credits: nextCredits,
      package: pkg,
    };
  });
}

async function logSearchInFirestore({ username }) {
  if (!firestoreDb || !admin) {
    return;
  }

  const now = admin.firestore.FieldValue.serverTimestamp();
  const usernameDocId = toDocSafeId(username.toLowerCase());
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

const ANALYZE_QUERY = `
  query userProblemsSolved($username: String!) {
    allQuestionsCount {
      difficulty
      count
    }
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
        fundamental {
          tagName
          problemsSolved
        }
        intermediate {
          tagName
          problemsSolved
        }
        advanced {
          tagName
          problemsSolved
        }
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
  return entry ? Number(entry.count || 0) : 0;
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

async function fetchRecentSolvedProblems(username) {
  const payload = await postLeetCodeQuery(
    username,
    RECENT_SOLVED_QUERY_ROOT,
  ).catch(async () => {
    return postLeetCodeQuery(username, RECENT_SUBMISSIONS_QUERY_ROOT);
  });

  const source =
    payload?.recentAcSubmissionList || payload?.recentSubmissionList || [];
  return source
    .filter(
      (item) =>
        !item.statusDisplay ||
        (item.statusDisplay || "").toLowerCase() === "accepted",
    )
    .map((item) => ({
      title: item.title || "Unknown Problem",
      titleSlug: item.titleSlug || "",
      solvedAtEpoch: Number(item.timestamp || 0),
      solvedAtIso:
        Number(item.timestamp || 0) > 0
          ? new Date(Number(item.timestamp) * 1000).toISOString()
          : null,
      url: item.titleSlug
        ? `https://leetcode.com/problems/${item.titleSlug}/`
        : null,
    }));
}

function buildCoachPrompt(analysis) {
  const topicSummary = analysis.topics
    .slice(0, 15)
    .map((topic) => `${topic.name}: ${topic.percentage.toFixed(1)}%`)
    .join(", ");

  return [
    "You are an expert competitive programming coach and hiring evaluator.",
    "Generate a practical 8-section report for this candidate.",
    `Total solved: ${analysis.totals.solved}`,
    `Easy/Medium/Hard: ${analysis.difficulty.easy.solved}/${analysis.difficulty.medium.solved}/${analysis.difficulty.hard.solved}`,
    `Acceptance rate: ${analysis.acceptanceRate.toFixed(2)}`,
    `Contest rating: ${analysis.contestRating.toFixed(0)}`,
    `Topics: ${topicSummary || "No topic data"}`,
    "Sections required: insights, skill score, company readiness, topic breakdown, weaknesses, 7-day plan, verdict, ETA to FAANG.",
  ].join("\n");
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
  const totalSubmissions = Number(
    solved.find((item) => item.difficulty === "All")?.submissions || 0,
  );
  const totalQuestions = getDifficultyCount(totals, "All");

  const easySolved = getDifficultyCount(solved, "Easy");
  const mediumSolved = getDifficultyCount(solved, "Medium");
  const hardSolved = getDifficultyCount(solved, "Hard");

  const easyTotal = getDifficultyCount(totals, "Easy");
  const mediumTotal = getDifficultyCount(totals, "Medium");
  const hardTotal = getDifficultyCount(totals, "Hard");

  const tagBuckets = matchedUser.tagProblemCounts || {};
  const topicMap = new Map();
  ["fundamental", "intermediate", "advanced"].forEach((bucket) => {
    (tagBuckets[bucket] || []).forEach((item) => {
      if (!item.tagName) {
        return;
      }
      topicMap.set(
        item.tagName,
        (topicMap.get(item.tagName) || 0) + Number(item.problemsSolved || 0),
      );
    });
  });

  const topics = [...topicMap.entries()]
    .map(([name, solvedCount]) => ({
      name,
      solved: solvedCount,
      percentage: totalSolved > 0 ? (solvedCount / totalSolved) * 100 : 0,
    }))
    .sort((a, b) => b.solved - a.solved);

  const recentSolvedProblems = await fetchRecentSolvedProblems(username).catch(
    () => [],
  );

  let contestRating = 0;
  try {
    const contestData = await postLeetCodeQuery(username, CONTEST_QUERY);
    contestRating = Number(contestData?.userContestRanking?.rating || 0);
  } catch (_error) {
    contestRating = 0;
  }

  let streak = 0;
  let last30DaysSubmissions = 0;
  try {
    const calendarData = await postLeetCodeQuery(username, CALENDAR_QUERY);
    const cal = calendarData?.matchedUser?.userCalendar;
    streak = Number(cal?.streak || 0);

    if (cal?.submissionCalendar) {
      const map = JSON.parse(cal.submissionCalendar);
      const nowSec = Math.floor(Date.now() / 1000);
      const start = nowSec - 30 * 24 * 60 * 60;
      Object.entries(map).forEach(([ts, count]) => {
        const t = Number(ts);
        if (t >= start && t <= nowSec) {
          last30DaysSubmissions += Number(count || 0);
        }
      });
    }
  } catch (_error) {
    streak = 0;
    last30DaysSubmissions = 0;
  }

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
    recentActivity: {
      last30DaysSubmissions,
      streak,
      consistency:
        last30DaysSubmissions >= 20
          ? "High"
          : last30DaysSubmissions >= 8
            ? "Medium"
            : "Low",
      dailyHeatmap: [],
    },
    timing: {
      avgAcceptedPerDayLast30: Number((last30DaysSubmissions / 30).toFixed(2)),
      avgHoursBetweenAccepted: null,
      lastSolvedAtIso: recentSolvedProblems[0]?.solvedAtIso || null,
      recentAcceptedCount: recentSolvedProblems.length,
    },
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

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "leetcode-analyzer-api",
    timestamp: new Date().toISOString(),
  });
});

app.get("/api/stats", (_req, res) => {
  res.json({ solved: 0, easy: 0, medium: 0, hard: 0, streak: 0 });
});

app.post("/api/auth/sync", verifyFirebaseToken, async (req, res) => {
  try {
    const userDoc = await ensureUserDocument(req.authUser, req);
    const user = toPublicUserProfile(req.authUser.uid, userDoc, req.authUser);
    return res.json({ credits: Number(userDoc.credits || 0), user });
  } catch (error) {
    return res
      .status(500)
      .json({
        error: "Unable to sync authenticated user.",
        details: error.message,
      });
  }
});

app.get("/api/profile", verifyFirebaseToken, async (req, res) => {
  try {
    const userDoc = await ensureUserDocument(req.authUser, req);
    const user = toPublicUserProfile(req.authUser.uid, userDoc, req.authUser);
    return res.json({ credits: Number(userDoc.credits || 0), user });
  } catch (error) {
    return res
      .status(500)
      .json({ error: "Unable to load profile.", details: error.message });
  }
});

app.put("/api/profile", verifyFirebaseToken, async (req, res) => {
  try {
    const ref = getUserRef(req.authUser.uid);
    await ensureUserDocument(req.authUser, req);

    const updates = sanitizeProfilePayload(req.body);
    updates.ipAddress = getClientIp(req);
    updates.updatedAt = admin.firestore.FieldValue.serverTimestamp();
    await ref.set(updates, { merge: true });

    const latestSnap = await ref.get();
    const latestData = latestSnap.data() || {};
    const user = toPublicUserProfile(
      req.authUser.uid,
      latestData,
      req.authUser,
    );
    return res.json({ credits: Number(latestData.credits || 0), user });
  } catch (error) {
    return res
      .status(500)
      .json({ error: "Unable to save profile.", details: error.message });
  }
});

app.post("/api/credits/purchase", verifyFirebaseToken, async (req, res) => {
  const packageKey = (req.body?.packageKey || "").toString().trim();

  try {
    await ensureUserDocument(req.authUser, req);
    const result = await addCreditsForPackage(req.authUser.uid, packageKey);

    const latestSnap = await getUserRef(req.authUser.uid).get();
    const latestData = latestSnap.data() || {};
    const user = toPublicUserProfile(
      req.authUser.uid,
      latestData,
      req.authUser,
    );

    return res.json({
      credits: result.credits,
      addedCredits: result.package.credits,
      amountRs: result.package.priceRs,
      user,
    });
  } catch (error) {
    const status = error.status || 500;
    return res.status(status).json({
      error:
        status === 400
          ? "Invalid credits package selected."
          : "Unable to purchase credits.",
      details: error.message,
    });
  }
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

app.post("/api/coach", verifyFirebaseToken, async (req, res) => {
  const username = (req.body?.username || "").toString().trim();
  if (!username) {
    return res.status(400).json({ error: "Username is required." });
  }

  try {
    await ensureUserDocument(req.authUser, req);

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
      return res
        .status(502)
        .json({ error: payload.error?.message || "Groq API request failed." });
    }

    const report = payload.choices?.[0]?.message?.content;
    if (!report) {
      return res
        .status(502)
        .json({ error: "Groq returned an empty response." });
    }

    const remainingCredits = await consumeOneCredit(req.authUser.uid);

    return res.json({
      username: analysis.username,
      model: GROQ_MODEL,
      report,
      remainingCredits,
      snapshot: analysis,
    });
  } catch (error) {
    const status = error.status || 500;
    return res.status(status).json({
      error:
        status === 404
          ? "LeetCode username not found."
          : status === 402
            ? "You have no credits remaining."
            : "Unexpected error while generating coach report.",
      details: error.message,
    });
  }
});

const frontendDir = fs.existsSync(path.join(FRONTEND_BUILD_DIR, "index.html"))
  ? FRONTEND_BUILD_DIR
  : fs.existsSync(path.join(FRONTEND_DIST_DIR, "index.html"))
    ? FRONTEND_DIST_DIR
    : LEGACY_PUBLIC_DIR;

app.use("/api", (_req, res) => {
  res.status(404).json({ error: "API route not found." });
});

app.use(express.static(frontendDir));

app.use((_req, res) => {
  res.sendFile(path.join(frontendDir, "index.html"));
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Frontend directory: ${frontendDir}`);
});
