const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const path = require("path");

dotenv.config({ path: path.join(__dirname, ".env") });

const app = express();
const PORT = process.env.PORT || 5000;
const LEETCODE_GRAPHQL = "https://leetcode.com/graphql";
const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";

app.use(cors());
app.use(express.json());

const ANALYZE_QUERY = `
  query userPublicProfile($username: String!) {
    matchedUser(username: $username) {
      username
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
    dailyHeatmap: buildDailyHeatmap(submissionMap, 140),
  };
}

function buildDailyHeatmap(submissionMap, days) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const points = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const ts = Math.floor(d.getTime() / 1000).toString();
    const count = Number(submissionMap[ts] || 0);
    points.push({
      date: d.toISOString().slice(0, 10),
      count,
    });
  }

  return points;
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

  return {
    username: matchedUser.username,
    totals: {
      solved: totalSolved,
      questions: totalQuestions,
      percentage: totalQuestions > 0 ? (totalSolved / totalQuestions) * 100 : 0,
    },
    acceptanceRate:
      totalSubmissions > 0 ? (totalSolved / totalSubmissions) * 100 : 0,
    contestRating,
    recentActivity,
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
* FAANG: percentage + one reason
* Product-based companies: percentage + one reason
* Service-based companies: percentage + one reason

4. Topic Breakdown:
* Strong topics
* Average topics
* Weak topics (must highlight DP, Graph, Trees when weak)

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

app.listen(PORT, () => {
  console.log(`API running on http://localhost:${PORT}`);
});
