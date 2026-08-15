require("dotenv").config();

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const QRCode = require("qrcode");
const os = require("os");
const path = require("path");

const round1Questions = require("./data/matching_round.json");
const round2Questions = require("./data/dating_round.json");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = Number(process.env.PORT || 3000);
const ADMIN_KEY = process.env.ADMIN_KEY || "hochzeit2026";

app.use(express.static(path.join(__dirname, "public")));

app.get("/admin", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

function getLanIp() {
  const interfaces = os.networkInterfaces();

  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (
        entry.family === "IPv4" &&
        !entry.internal &&
        !entry.address.startsWith("169.254.")
      ) {
        return entry.address;
      }
    }
  }

  return "localhost";
}

app.get("/api/join-info", async (_req, res) => {
  const joinUrl = `http://${getLanIp()}:${PORT}`;
  const qrDataUrl = await QRCode.toDataURL(joinUrl, {
    margin: 1,
    width: 320
  });

  res.json({ joinUrl, qrDataUrl });
});

const participants = new Map();

const game = {
  round: 1,
  phase: "lobby", // lobby | question | reveal | matching | round2_ready | finished
  currentQuestionIndex: null,
  answers: {
    1: new Map(),
    2: new Map()
  },
  completedQuestions: {
    1: new Set(),
    2: new Set()
  },
  pairs: [],
  unmatchedClientId: null
};

function questionsForRound(round) {
  return round === 2 ? round2Questions : round1Questions;
}

function ensureAnswerSheet(round, clientId) {
  const roundAnswers = game.answers[round];

  if (!roundAnswers.has(clientId)) {
    roundAnswers.set(clientId, new Array(questionsForRound(round).length).fill(null));
  }

  return roundAnswers.get(clientId);
}

function normalizeName(value, maxLength = 40) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, maxLength);
}

function isPseudonymTaken(pseudonym, ownClientId = null) {
  const normalized = pseudonym.toLocaleLowerCase("de-DE");

  return [...participants.values()].some(
    (participant) =>
      participant.clientId !== ownClientId &&
      participant.pseudonym.toLocaleLowerCase("de-DE") === normalized
  );
}

function participantPublicName(participant) {
  return game.round === 1 && !["matching", "round2_ready", "finished"].includes(game.phase)
    ? participant.pseudonym
    : participant.realName;
}

function publicParticipants() {
  return [...participants.values()].map((participant) => ({
    clientId: participant.clientId,
    displayName: participantPublicName(participant),
    pseudonym: participant.pseudonym,
    connected: participant.connected
  }));
}

function adminParticipants() {
  const revealRealNames = ["matching", "round2_ready", "finished"].includes(game.phase) || game.round === 2;

  return [...participants.values()].map((participant) => ({
    clientId: participant.clientId,
    displayName: revealRealNames ? participant.realName : participant.pseudonym,
    pseudonym: participant.pseudonym,
    realName: revealRealNames ? participant.realName : null,
    connected: participant.connected,
    round1Answered: ensureAnswerSheet(1, participant.clientId).filter((value) => value !== null).length,
    round2Answered: ensureAnswerSheet(2, participant.clientId).filter((value) => value !== null).length
  }));
}

function currentQuestion() {
  if (game.currentQuestionIndex === null) return null;
  return questionsForRound(game.round)[game.currentQuestionIndex] || null;
}

function currentQuestionForGuests() {
  const question = currentQuestion();
  if (!question) return null;

  return {
    id: question.id,
    text: question.text,
    options: question.options
  };
}

function getAnswer(round, clientId, questionIndex) {
  return ensureAnswerSheet(round, clientId)[questionIndex] ?? null;
}

function answerCounts(round, questionIndex) {
  const counts = [0, 0];

  for (const clientId of participants.keys()) {
    const answer = getAnswer(round, clientId, questionIndex);
    if (answer === 0 || answer === 1) counts[answer] += 1;
  }

  return counts;
}

function currentAnswerCounts() {
  if (game.currentQuestionIndex === null) return [0, 0];
  return answerCounts(game.round, game.currentQuestionIndex);
}

function currentAnswerTotal() {
  const counts = currentAnswerCounts();
  return counts[0] + counts[1];
}

function countAgreement(clientA, clientB, round, upToCompletedOnly = false) {
  const questions = questionsForRound(round);
  const answersA = ensureAnswerSheet(round, clientA);
  const answersB = ensureAnswerSheet(round, clientB);
  let agreement = 0;
  let compared = 0;

  for (let index = 0; index < questions.length; index += 1) {
    if (upToCompletedOnly && !game.completedQuestions[round].has(index)) continue;

    const answerA = answersA[index];
    const answerB = answersB[index];

    if ((answerA === 0 || answerA === 1) && (answerB === 0 || answerB === 1)) {
      compared += 1;
      if (answerA === answerB) agreement += 1;
    }
  }

  return { agreement, compared };
}

function createPairsGreedy() {
  const ids = [...participants.keys()];
  const candidates = [];

  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const stats = countAgreement(ids[i], ids[j], 1, false);
      candidates.push({
        a: ids[i],
        b: ids[j],
        agreement: stats.agreement,
        compared: stats.compared
      });
    }
  }

  candidates.sort((left, right) => {
    if (right.agreement !== left.agreement) return right.agreement - left.agreement;
    if (right.compared !== left.compared) return right.compared - left.compared;

    const leftKey = [participants.get(left.a)?.pseudonym, participants.get(left.b)?.pseudonym]
      .sort()
      .join("|");
    const rightKey = [participants.get(right.a)?.pseudonym, participants.get(right.b)?.pseudonym]
      .sort()
      .join("|");

    return leftKey.localeCompare(rightKey, "de");
  });

  const assigned = new Set();
  const pairs = [];

  for (const candidate of candidates) {
    if (assigned.has(candidate.a) || assigned.has(candidate.b)) continue;

    assigned.add(candidate.a);
    assigned.add(candidate.b);

    pairs.push({
      id: `pair-${pairs.length + 1}`,
      memberA: candidate.a,
      memberB: candidate.b,
      round1Agreement: candidate.agreement
    });
  }

  const unmatchedClientId = ids.find((id) => !assigned.has(id)) || null;

  return { pairs, unmatchedClientId };
}

function pairView(pair) {
  const memberA = participants.get(pair.memberA);
  const memberB = participants.get(pair.memberB);
  const round2Stats = countAgreement(pair.memberA, pair.memberB, 2, true);

  return {
    id: pair.id,
    memberA: memberA
      ? { clientId: memberA.clientId, realName: memberA.realName, pseudonym: memberA.pseudonym }
      : null,
    memberB: memberB
      ? { clientId: memberB.clientId, realName: memberB.realName, pseudonym: memberB.pseudonym }
      : null,
    round1Agreement: pair.round1Agreement,
    round2Agreement: round2Stats.agreement,
    round2Compared: round2Stats.compared
  };
}

function pairViews() {
  return game.pairs.map(pairView).sort((left, right) => {
    if (game.round === 2 || game.phase === "finished") {
      if (right.round2Agreement !== left.round2Agreement) {
        return right.round2Agreement - left.round2Agreement;
      }
    }
    return right.round1Agreement - left.round1Agreement;
  });
}

function winnerPairs() {
  const pairs = pairViews();
  if (!pairs.length) return [];

  const best = Math.max(...pairs.map((pair) => pair.round2Agreement));
  return pairs.filter((pair) => pair.round2Agreement === best);
}

function partnerFor(clientId) {
  const pair = game.pairs.find(
    (candidate) => candidate.memberA === clientId || candidate.memberB === clientId
  );

  if (!pair) return null;

  const partnerId = pair.memberA === clientId ? pair.memberB : pair.memberA;
  const partner = participants.get(partnerId);

  return partner
    ? { realName: partner.realName, pseudonym: partner.pseudonym }
    : null;
}

function gameStateForGuests(clientId) {
  const question = currentQuestionForGuests();
  const ownAnswer =
    game.currentQuestionIndex === null
      ? null
      : getAnswer(game.round, clientId, game.currentQuestionIndex);

  return {
    phase: game.phase,
    round: game.round,
    roundLabel: game.round === 1 ? "Findungsrunde" : "Pärchenrunde",
    currentQuestionIndex: game.currentQuestionIndex,
    totalQuestions: questionsForRound(game.round).length,
    question,
    ownAnswer,
    answerCounts: game.phase === "reveal" ? currentAnswerCounts() : null,
    partner: game.round === 2 || ["matching", "round2_ready", "finished"].includes(game.phase)
      ? partnerFor(clientId)
      : null,
    isUnmatched: game.unmatchedClientId === clientId
  };
}

function gameStateForAdmin() {
  const unmatched = game.unmatchedClientId ? participants.get(game.unmatchedClientId) : null;

  return {
    phase: game.phase,
    round: game.round,
    roundLabel: game.round === 1 ? "Findungsrunde" : "Pärchenrunde",
    currentQuestionIndex: game.currentQuestionIndex,
    totalQuestions: questionsForRound(game.round).length,
    question: currentQuestion(),
    questions: questionsForRound(game.round),
    answerCounts: currentAnswerCounts(),
    answerTotal: currentAnswerTotal(),
    completedQuestions: [...game.completedQuestions[game.round]],
    round1Complete: game.completedQuestions[1].size === round1Questions.length,
    round2Complete: game.completedQuestions[2].size === round2Questions.length,
    pairs: pairViews(),
    unmatched: unmatched
      ? { realName: unmatched.realName, pseudonym: unmatched.pseudonym }
      : null,
    winners: game.phase === "finished" ? winnerPairs() : []
  };
}

function emitParticipantLists() {
  io.to("admin").emit("participants:update", adminParticipants());
}

function emitGameStateToAll() {
  io.to("admin").emit("game:update", gameStateForAdmin());

  for (const [clientId, participant] of participants.entries()) {
    if (participant.socketId) {
      io.to(participant.socketId).emit("game:update", gameStateForGuests(clientId));
    }
  }
}

io.on("connection", (socket) => {
  socket.on("admin:join", ({ key } = {}, callback = () => {}) => {
    if (key !== ADMIN_KEY) {
      callback({ ok: false, error: "Falscher Admin-Schlüssel." });
      return;
    }

    socket.join("admin");
    socket.data.isAdmin = true;

    callback({
      ok: true,
      participants: adminParticipants(),
      game: gameStateForAdmin()
    });
  });

  socket.on(
    "participant:join",
    ({ clientId, realName, pseudonym } = {}, callback = () => {}) => {
      clientId = normalizeName(clientId, 80);
      realName = normalizeName(realName);
      pseudonym = normalizeName(pseudonym);

      if (!clientId || !realName || !pseudonym) {
        callback({
          ok: false,
          error: "Bitte echten Namen und Pseudonym vollständig eingeben."
        });
        return;
      }

      if (isPseudonymTaken(pseudonym, clientId)) {
        callback({ ok: false, error: "Dieses Pseudonym ist bereits vergeben." });
        return;
      }

      const existing = participants.get(clientId);

      if (game.pairs.length > 0 && !existing) {
        callback({
          ok: false,
          error: "Das Matching ist bereits abgeschlossen. Neue Gäste können jetzt nicht mehr beitreten."
        });
        return;
      }

      participants.set(clientId, {
        clientId,
        realName,
        pseudonym,
        socketId: socket.id,
        connected: true
      });

      ensureAnswerSheet(1, clientId);
      ensureAnswerSheet(2, clientId);
      socket.data.clientId = clientId;

      callback({
        ok: true,
        participant: {
          clientId,
          pseudonym,
          realName
        },
        game: gameStateForGuests(clientId)
      });

      emitParticipantLists();
      if (existing) emitGameStateToAll();
    }
  );

  socket.on(
    "participant:answer",
    ({ optionIndex } = {}, callback = () => {}) => {
      const clientId = socket.data.clientId;

      if (!clientId || !participants.has(clientId)) {
        callback({ ok: false, error: "Du bist nicht angemeldet." });
        return;
      }

      if (game.phase !== "question" || game.currentQuestionIndex === null) {
        callback({ ok: false, error: "Aktuell kann nicht abgestimmt werden." });
        return;
      }

      if (game.round === 2 && game.unmatchedClientId === clientId) {
        callback({ ok: false, error: "Du hast aktuell kein Match für die Pärchenrunde." });
        return;
      }

      if (optionIndex !== 0 && optionIndex !== 1) {
        callback({ ok: false, error: "Ungültige Antwort." });
        return;
      }

      const sheet = ensureAnswerSheet(game.round, clientId);
      sheet[game.currentQuestionIndex] = optionIndex;

      callback({ ok: true, optionIndex });
      io.to("admin").emit("game:update", gameStateForAdmin());
    }
  );

  socket.on(
    "admin:startQuestion",
    ({ key, questionIndex } = {}, callback = () => {}) => {
      if (!socket.data.isAdmin || key !== ADMIN_KEY) {
        callback({ ok: false, error: "Nicht autorisiert." });
        return;
      }

      if (["matching", "finished"].includes(game.phase)) {
        callback({ ok: false, error: "In dieser Spielphase kann keine Frage gestartet werden." });
        return;
      }

      const questions = questionsForRound(game.round);

      if (
        !Number.isInteger(questionIndex) ||
        questionIndex < 0 ||
        questionIndex >= questions.length
      ) {
        callback({ ok: false, error: "Ungültige Frage." });
        return;
      }

      game.currentQuestionIndex = questionIndex;
      game.phase = "question";

      emitGameStateToAll();
      callback({ ok: true });
    }
  );

  socket.on("admin:reveal", ({ key } = {}, callback = () => {}) => {
    if (!socket.data.isAdmin || key !== ADMIN_KEY) {
      callback({ ok: false, error: "Nicht autorisiert." });
      return;
    }

    if (game.phase !== "question" || game.currentQuestionIndex === null) {
      callback({ ok: false, error: "Es läuft keine offene Frage." });
      return;
    }

    game.completedQuestions[game.round].add(game.currentQuestionIndex);
    game.phase = "reveal";

    emitGameStateToAll();
    emitParticipantLists();
    callback({ ok: true });
  });

  socket.on("admin:createMatches", ({ key } = {}, callback = () => {}) => {
    if (!socket.data.isAdmin || key !== ADMIN_KEY) {
      callback({ ok: false, error: "Nicht autorisiert." });
      return;
    }

    if (game.completedQuestions[1].size !== round1Questions.length) {
      callback({
        ok: false,
        error: `Erst alle ${round1Questions.length} Fragen der Findungsrunde abschließen.`
      });
      return;
    }

    if (participants.size < 2) {
      callback({ ok: false, error: "Für ein Matching werden mindestens zwei Gäste benötigt." });
      return;
    }

    const result = createPairsGreedy();
    game.pairs = result.pairs;
    game.unmatchedClientId = result.unmatchedClientId;
    game.phase = "matching";
    game.currentQuestionIndex = null;

    emitGameStateToAll();
    emitParticipantLists();
    callback({ ok: true });
  });

  socket.on("admin:startRound2", ({ key } = {}, callback = () => {}) => {
    if (!socket.data.isAdmin || key !== ADMIN_KEY) {
      callback({ ok: false, error: "Nicht autorisiert." });
      return;
    }

    if (!game.pairs.length) {
      callback({ ok: false, error: "Bitte zuerst das Matching durchführen." });
      return;
    }

    game.round = 2;
    game.phase = "round2_ready";
    game.currentQuestionIndex = null;

    emitGameStateToAll();
    emitParticipantLists();
    callback({ ok: true });
  });

  socket.on("admin:finish", ({ key } = {}, callback = () => {}) => {
    if (!socket.data.isAdmin || key !== ADMIN_KEY) {
      callback({ ok: false, error: "Nicht autorisiert." });
      return;
    }

    if (game.completedQuestions[2].size !== round2Questions.length) {
      callback({
        ok: false,
        error: `Erst alle ${round2Questions.length} Fragen der Pärchenrunde abschließen.`
      });
      return;
    }

    game.phase = "finished";
    game.currentQuestionIndex = null;

    emitGameStateToAll();
    callback({ ok: true });
  });

  socket.on("disconnect", () => {
    const clientId = socket.data.clientId;

    if (clientId && participants.has(clientId)) {
      const participant = participants.get(clientId);

      if (participant.socketId === socket.id) {
        participant.connected = false;
        participant.socketId = null;
        emitParticipantLists();
      }
    }
  });
});

server.listen(PORT, "0.0.0.0", () => {
  const lanIp = getLanIp();

  console.log("");
  console.log("Love-is-Phina läuft:");
  console.log(`Gäste:  http://${lanIp}:${PORT}`);
  console.log(`Admin:  http://localhost:${PORT}/admin`);
  console.log("");
});
