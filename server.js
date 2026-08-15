require("dotenv").config();

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const QRCode = require("qrcode");
const os = require("os");
const path = require("path");

const questions = require("./data/questions.json");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = Number(process.env.PORT || 3000);
const ADMIN_KEY = process.env.ADMIN_KEY || "phina2026";

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
  currentQuestionIndex: null,
  phase: "lobby", // lobby | question | reveal | finished
  answers: new Map()
};

function publicParticipants() {
  return [...participants.values()].map((participant) => ({
    clientId: participant.clientId,
    pseudonym: participant.pseudonym,
    connected: participant.connected,
    score: participant.score
  }));
}

function adminParticipants() {
  return [...participants.values()].map((participant) => ({
    clientId: participant.clientId,
    realName: participant.realName,
    pseudonym: participant.pseudonym,
    connected: participant.connected,
    score: participant.score
  }));
}

function currentQuestionForGuests() {
  if (game.currentQuestionIndex === null) return null;

  const q = questions[game.currentQuestionIndex];

  return {
    id: q.id,
    text: q.text,
    options: q.options
  };
}

function answerCounts() {
  const counts = [0, 0];

  for (const answer of game.answers.values()) {
    if (answer.optionIndex === 0 || answer.optionIndex === 1) {
      counts[answer.optionIndex] += 1;
    }
  }

  return counts;
}

function gameStateForGuests(clientId) {
  return {
    phase: game.phase,
    currentQuestionIndex: game.currentQuestionIndex,
    totalQuestions: questions.length,
    question: currentQuestionForGuests(),
    ownAnswer: game.answers.get(clientId)?.optionIndex ?? null,
    answerCounts: game.phase === "reveal" ? answerCounts() : null,
    correctOption:
      game.phase === "reveal" && game.currentQuestionIndex !== null
        ? questions[game.currentQuestionIndex].correctOption ?? null
        : null
  };
}

function gameStateForAdmin() {
  return {
    phase: game.phase,
    currentQuestionIndex: game.currentQuestionIndex,
    totalQuestions: questions.length,
    question:
      game.currentQuestionIndex === null
        ? null
        : questions[game.currentQuestionIndex],
    answerCounts: answerCounts(),
    answerTotal: game.answers.size
  };
}

function emitParticipantLists() {
  io.to("admin").emit("participants:update", adminParticipants());
}

function emitGameStateToAll() {
  io.to("admin").emit("game:update", gameStateForAdmin());

  for (const [clientId, participant] of participants.entries()) {
    if (participant.socketId) {
      io.to(participant.socketId).emit(
        "game:update",
        gameStateForGuests(clientId)
      );
    }
  }
}

function normalizeName(value, maxLength = 40) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, maxLength);
}

function isPseudonymTaken(pseudonym, ownClientId = null) {
  const normalized = pseudonym.toLocaleLowerCase("de-DE");

  return [...participants.values()].some(
    (p) =>
      p.clientId !== ownClientId &&
      p.pseudonym.toLocaleLowerCase("de-DE") === normalized
  );
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
      questions,
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
        callback({
          ok: false,
          error: "Dieses Pseudonym ist bereits vergeben."
        });
        return;
      }

      const existing = participants.get(clientId);

      participants.set(clientId, {
        clientId,
        realName,
        pseudonym,
        socketId: socket.id,
        connected: true,
        score: existing?.score || 0
      });

      socket.data.clientId = clientId;

      callback({
        ok: true,
        participant: {
          clientId,
          pseudonym,
          score: participants.get(clientId).score
        },
        game: gameStateForGuests(clientId)
      });

      emitParticipantLists();
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

      if (optionIndex !== 0 && optionIndex !== 1) {
        callback({ ok: false, error: "Ungültige Antwort." });
        return;
      }

      game.answers.set(clientId, {
        optionIndex,
        answeredAt: Date.now()
      });

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
      game.answers.clear();

      emitGameStateToAll();
      callback({ ok: true });
    }
  );

  socket.on("admin:reveal", ({ key } = {}, callback = () => {}) => {
    if (!socket.data.isAdmin || key !== ADMIN_KEY) {
      callback({ ok: false, error: "Nicht autorisiert." });
      return;
    }

    if (game.currentQuestionIndex === null) {
      callback({ ok: false, error: "Es läuft keine Frage." });
      return;
    }

    const question = questions[game.currentQuestionIndex];

    if (question.correctOption === 0 || question.correctOption === 1) {
      for (const [clientId, answer] of game.answers.entries()) {
        if (answer.optionIndex === question.correctOption) {
          const participant = participants.get(clientId);
          if (participant) participant.score += 1;
        }
      }
    }

    game.phase = "reveal";
    emitGameStateToAll();
    emitParticipantLists();

    callback({ ok: true });
  });

  socket.on("admin:finish", ({ key } = {}, callback = () => {}) => {
    if (!socket.data.isAdmin || key !== ADMIN_KEY) {
      callback({ ok: false, error: "Nicht autorisiert." });
      return;
    }

    game.phase = "finished";
    emitGameStateToAll();
    emitParticipantLists();

    callback({ ok: true });
  });

  socket.on("disconnect", () => {
    const clientId = socket.data.clientId;

    if (clientId && participants.has(clientId)) {
      const participant = participants.get(clientId);

      // Nur als offline markieren, wenn dies noch dieselbe Socket-Verbindung ist.
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
  console.log("Hochzeitsquiz läuft:");
  console.log(`Gäste:  http://${lanIp}:${PORT}`);
  console.log(`Admin:  http://localhost:${PORT}/admin`);
  console.log("");
});
