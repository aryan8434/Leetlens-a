module.exports = function registerLiveRoutes(app, deps) {
  const {
    verifyFirebaseToken,
    buildAnalysisData,
    buildCoachPrompt,
    consumeOneCredit,
    ensureUserDocument,
    toPublicUserProfile,
    getUserRef,
    sanitizeProfilePayload,
    addCreditsForPackage,
    GROQ_MODEL,
    GROQ_API_URL,
    admin,
  } = deps;

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

  app.post("/api/auth/sync", verifyFirebaseToken, async (req, res) => {
    try {
      const userDoc = await ensureUserDocument(req.authUser);
      const user = toPublicUserProfile(req.authUser.uid, userDoc, req.authUser);

      return res.json({
        credits: Number(userDoc.credits || 0),
        user,
      });
    } catch (error) {
      return res.status(500).json({
        error: "Unable to sync authenticated user.",
        details: error.message,
      });
    }
  });

  app.get("/api/profile", verifyFirebaseToken, async (req, res) => {
    try {
      const userDoc = await ensureUserDocument(req.authUser);
      const user = toPublicUserProfile(req.authUser.uid, userDoc, req.authUser);
      return res.json({
        credits: Number(userDoc.credits || 0),
        user,
      });
    } catch (error) {
      return res.status(500).json({
        error: "Unable to load profile.",
        details: error.message,
      });
    }
  });

  app.put("/api/profile", verifyFirebaseToken, async (req, res) => {
    try {
      const ref = getUserRef(req.authUser.uid);
      await ensureUserDocument(req.authUser);

      const updates = sanitizeProfilePayload(req.body);
      updates.updatedAt = admin.firestore.FieldValue.serverTimestamp();
      await ref.set(updates, { merge: true });

      const latestSnap = await ref.get();
      const latestData = latestSnap.data() || {};
      const user = toPublicUserProfile(
        req.authUser.uid,
        latestData,
        req.authUser,
      );
      return res.json({
        credits: Number(latestData.credits || 0),
        user,
      });
    } catch (error) {
      return res.status(500).json({
        error: "Unable to save profile.",
        details: error.message,
      });
    }
  });

  app.post("/api/credits/purchase", verifyFirebaseToken, async (req, res) => {
    const packageKey = (req.body?.packageKey || "").toString().trim();

    try {
      const userDoc = await ensureUserDocument(req.authUser);
      const result = await addCreditsForPackage(req.authUser.uid, packageKey);
      const user = toPublicUserProfile(req.authUser.uid, userDoc, req.authUser);

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
};
