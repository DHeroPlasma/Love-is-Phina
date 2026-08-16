require("dotenv").config();

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const QRCode = require("qrcode");
const os = require("os");
const path = require("path");

const RecoveryService = require("./services/RecoveryService");

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

/*
|--------------------------------------------------------------------------
| Recovery
|--------------------------------------------------------------------------
*/

const recovery = new RecoveryService({
  stateFile: path.join(__dirname, "data", "game-state.json"),
  backupFile: path.join(__dirname, "data", "game-state.backup.json"),
  tempFile: path.join(__dirname, "data", "game-state.tmp.json")
});

/*
|--------------------------------------------------------------------------
| Game State
|--------------------------------------------------------------------------
*/

const participants = new Map();

const game = {
  round: 1,

  // lobby | question | reveal | matching | round2_ready | finished
  phase: "lobby",

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

/*
|--------------------------------------------------------------------------
| Helper
|--------------------------------------------------------------------------
*/

function getQuestionsForRound(round) {
  return round === 2 ? round2Questions : round1Questions;
}

function getCurrentQuestions() {
  return getQuestionsForRound(game.round);
}

function normalizeName(value, maxLength = 40) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, maxLength);
}

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

function isPseudonymTaken(pseudonym, ownClientId = null) {
  const normalized = pseudonym.toLocaleLowerCase("de-DE");

  return [...participants.values()].some(
    (participant) =>
      participant.clientId !== ownClientId &&
      participant.pseudonym.toLocaleLowerCase("de-DE") === normalized
  );
}

function ensureAnswerSheet(round, clientId) {
  const questionCount = getQuestionsForRound(round).length;
  const answerMap = game.answers[round];

  if (!answerMap.has(clientId)) {
    answerMap.set(
      clientId,
      new Array(questionCount).fill(null)
    );
  }

  return answerMap.get(clientId);
}

function getParticipantPair(clientId) {
  return game.pairs.find(
    (pair) =>
      pair.memberA === clientId ||
      pair.memberB === clientId
  );
}

function getPartner(clientId) {
  const pair = getParticipantPair(clientId);

  if (!pair) return null;

  const partnerId =
    pair.memberA === clientId
      ? pair.memberB
      : pair.memberA;

  return participants.get(partnerId) || null;
}

/*
|--------------------------------------------------------------------------
| Persistence Mapping
|--------------------------------------------------------------------------
|
| RecoveryService selbst kennt keine Maps, Sets oder Spiellogik.
| Deshalb wandeln wir hier den Zustand in normales JSON um.
|--------------------------------------------------------------------------
*/

function buildPersistentState() {
  return {
    version: 1,

    participants: [...participants.values()].map((participant) => ({
      clientId: participant.clientId,
      realName: participant.realName,
      pseudonym: participant.pseudonym
    })),

    game: {
      round: game.round,
      phase: game.phase,
      currentQuestionIndex: game.currentQuestionIndex,

      answers: {
        1: Object.fromEntries(game.answers[1]),
        2: Object.fromEntries(game.answers[2])
      },

      completedQuestions: {
        1: [...game.completedQuestions[1]],
        2: [...game.completedQuestions[2]]
      },

      pairs: game.pairs,
      unmatchedClientId: game.unmatchedClientId
    }
  };
}

function saveGameState(reason) {
  recovery.save(buildPersistentState(), reason);
}

function isValidAnswerSheet(value, expectedLength) {
  return (
    Array.isArray(value) &&
    value.length === expectedLength &&
    value.every(
      (answer) =>
        answer === null ||
        answer === 0 ||
        answer === 1
    )
  );
}

function restoreGameState(savedState) {
  if (
    !savedState ||
    savedState.version !== 1 ||
    !savedState.game
  ) {
    throw new Error("Ungültiger Recovery-Spielstand.");
  }

  /*
  |--------------------------------------------------------------------------
  | Teilnehmer
  |--------------------------------------------------------------------------
  */

  participants.clear();

  for (const savedParticipant of savedState.participants || []) {
    if (
      !savedParticipant.clientId ||
      !savedParticipant.realName ||
      !savedParticipant.pseudonym
    ) {
      continue;
    }

    participants.set(savedParticipant.clientId, {
      clientId: savedParticipant.clientId,
      realName: savedParticipant.realName,
      pseudonym: savedParticipant.pseudonym,

      // Nach Server-Neustart zunächst offline.
      socketId: null,
      connected: false
    });
  }

  /*
  |--------------------------------------------------------------------------
  | Grundzustand
  |--------------------------------------------------------------------------
  */

  game.round =
    savedState.game.round === 2
      ? 2
      : 1;

  const validPhases = new Set([
    "lobby",
    "question",
    "reveal",
    "matching",
    "round2_ready",
    "finished"
  ]);

  game.phase = validPhases.has(savedState.game.phase)
    ? savedState.game.phase
    : "lobby";

  const questions = getQuestionsForRound(game.round);

  game.currentQuestionIndex =
    Number.isInteger(savedState.game.currentQuestionIndex) &&
    savedState.game.currentQuestionIndex >= 0 &&
    savedState.game.currentQuestionIndex < questions.length
      ? savedState.game.currentQuestionIndex
      : null;

  /*
  |--------------------------------------------------------------------------
  | Antworten
  |--------------------------------------------------------------------------
  */

  game.answers[1].clear();
  game.answers[2].clear();

  for (const round of [1, 2]) {
    const sourceAnswers =
      savedState.game.answers?.[round] || {};

    const expectedLength =
      getQuestionsForRound(round).length;

    for (const clientId of participants.keys()) {
      const storedSheet =
        sourceAnswers[clientId];

      const sheet = isValidAnswerSheet(
        storedSheet,
        expectedLength
      )
        ? [...storedSheet]
        : new Array(expectedLength).fill(null);

      game.answers[round].set(clientId, sheet);
    }
  }

  /*
  |--------------------------------------------------------------------------
  | Abgeschlossene Fragen
  |--------------------------------------------------------------------------
  */

  const completedRound1 =
    Array.isArray(
      savedState.game.completedQuestions?.[1]
    )
      ? savedState.game.completedQuestions[1]
      : [];

  const completedRound2 =
    Array.isArray(
      savedState.game.completedQuestions?.[2]
    )
      ? savedState.game.completedQuestions[2]
      : [];

  game.completedQuestions[1] = new Set(
    completedRound1.filter(
      (index) =>
        Number.isInteger(index) &&
        index >= 0 &&
        index < round1Questions.length
    )
  );

  game.completedQuestions[2] = new Set(
    completedRound2.filter(
      (index) =>
        Number.isInteger(index) &&
        index >= 0 &&
        index < round2Questions.length
    )
  );

  /*
  |--------------------------------------------------------------------------
  | Matches
  |--------------------------------------------------------------------------
  */

  game.pairs =
    Array.isArray(savedState.game.pairs)
      ? savedState.game.pairs.filter(
          (pair) =>
            pair &&
            participants.has(pair.memberA) &&
            participants.has(pair.memberB)
        )
      : [];

  game.unmatchedClientId =
    savedState.game.unmatchedClientId &&
    participants.has(
      savedState.game.unmatchedClientId
    )
      ? savedState.game.unmatchedClientId
      : null;
}

/*
|--------------------------------------------------------------------------
| Recovery beim Start
|--------------------------------------------------------------------------
*/

try {
  const savedState = recovery.load();

  if (savedState) {
    restoreGameState(savedState);

    console.log(
      `[Recovery] ${participants.size} Teilnehmer wiederhergestellt.`
    );
  }
} catch (error) {
  console.error(
    "[Recovery] Spielstand konnte nicht wiederhergestellt werden:",
    error
  );
}

/*
|--------------------------------------------------------------------------
| Matching
|--------------------------------------------------------------------------
*/

function calculateCompatibility(clientIdA, clientIdB) {
  const answersA =
    game.answers[1].get(clientIdA) || [];

  const answersB =
    game.answers[1].get(clientIdB) || [];

  let matches = 0;
  let compared = 0;

  for (
    let index = 0;
    index < round1Questions.length;
    index++
  ) {
    const answerA = answersA[index];
    const answerB = answersB[index];

    if (
      answerA === null ||
      answerA === undefined ||
      answerB === null ||
      answerB === undefined
    ) {
      continue;
    }

    compared++;

    if (answerA === answerB) {
      matches++;
    }
  }

  return {
    matches,
    compared
  };
}

function createMatches() {
  const clientIds = [...participants.keys()];

  const combinations = [];

  for (
    let firstIndex = 0;
    firstIndex < clientIds.length;
    firstIndex++
  ) {
    for (
      let secondIndex = firstIndex + 1;
      secondIndex < clientIds.length;
      secondIndex++
    ) {
      const memberA = clientIds[firstIndex];
      const memberB = clientIds[secondIndex];

      const compatibility =
        calculateCompatibility(
          memberA,
          memberB
        );

      combinations.push({
        memberA,
        memberB,
        matchingScore: compatibility.matches,
        comparedAnswers: compatibility.compared
      });
    }
  }

  combinations.sort((a, b) => {
    if (b.matchingScore !== a.matchingScore) {
      return b.matchingScore - a.matchingScore;
    }

    return (
      b.comparedAnswers -
      a.comparedAnswers
    );
  });

  const alreadyMatched = new Set();
  const pairs = [];

  for (const combination of combinations) {
    if (
      alreadyMatched.has(combination.memberA) ||
      alreadyMatched.has(combination.memberB)
    ) {
      continue;
    }

    pairs.push({
      memberA: combination.memberA,
      memberB: combination.memberB,
      round1Matches:
        combination.matchingScore,
      round1Compared:
        combination.comparedAnswers
    });

    alreadyMatched.add(combination.memberA);
    alreadyMatched.add(combination.memberB);
  }

  const unmatchedClientId =
    clientIds.find(
      (clientId) =>
        !alreadyMatched.has(clientId)
    ) || null;

  game.pairs = pairs;
  game.unmatchedClientId =
    unmatchedClientId;
}

/*
|--------------------------------------------------------------------------
| Round 2 Pair Scores
|--------------------------------------------------------------------------
*/

function calculatePairRound2Score(pair) {
  const answersA =
    game.answers[2].get(pair.memberA) || [];

  const answersB =
    game.answers[2].get(pair.memberB) || [];

  let matches = 0;
  let compared = 0;

  for (
    let index = 0;
    index < round2Questions.length;
    index++
  ) {
    if (
      !game.completedQuestions[2].has(index)
    ) {
      continue;
    }

    const answerA = answersA[index];
    const answerB = answersB[index];

    if (
      answerA === null ||
      answerA === undefined ||
      answerB === null ||
      answerB === undefined
    ) {
      continue;
    }

    compared++;

    if (answerA === answerB) {
      matches++;
    }
  }

  return {
    matches,
    compared
  };
}

function getPairResults() {
  return game.pairs
    .map((pair) => {
      const memberA =
        participants.get(pair.memberA);

      const memberB =
        participants.get(pair.memberB);

      const round2 =
        calculatePairRound2Score(pair);

      return {
        memberA: {
          clientId: pair.memberA,
          realName:
            memberA?.realName || "Unbekannt",
          pseudonym:
            memberA?.pseudonym || "?"
        },

        memberB: {
          clientId: pair.memberB,
          realName:
            memberB?.realName || "Unbekannt",
          pseudonym:
            memberB?.pseudonym || "?"
        },

        round1Matches:
          pair.round1Matches,

        round1Compared:
          pair.round1Compared,

        round2Matches:
          round2.matches,

        round2Compared:
          round2.compared
      };
    })
    .sort((a, b) => {
      if (
        b.round2Matches !==
        a.round2Matches
      ) {
        return (
          b.round2Matches -
          a.round2Matches
        );
      }

      return (
        b.round2Compared -
        a.round2Compared
      );
    });
}

function getWinners() {
  const results = getPairResults();

  if (results.length === 0) {
    return [];
  }

  const highestScore =
    results[0].round2Matches;

  return results.filter(
    (pair) =>
      pair.round2Matches ===
      highestScore
  );
}

/*
|--------------------------------------------------------------------------
| Public State
|--------------------------------------------------------------------------
*/

function publicParticipantsForAdmin() {
  const revealRealNames =
    game.phase === "matching" ||
    game.phase === "round2_ready" ||
    game.round === 2 ||
    game.phase === "finished";

  return [...participants.values()].map(
    (participant) => ({
      clientId:
        participant.clientId,

      pseudonym:
        participant.pseudonym,

      realName: revealRealNames
        ? participant.realName
        : null,

      connected:
        participant.connected
    })
  );
}

function getCurrentQuestionForGuest() {
  if (
    game.currentQuestionIndex === null
  ) {
    return null;
  }

  const question =
    getCurrentQuestions()[
      game.currentQuestionIndex
    ];

  if (!question) {
    return null;
  }

  return {
    id: question.id,
    text: question.text,
    options: question.options
  };
}

function getCurrentAnswerCounts() {
  const counts = [0, 0];

  if (
    game.currentQuestionIndex === null
  ) {
    return counts;
  }

  for (const answerSheet of game.answers[
    game.round
  ].values()) {
    const answer =
      answerSheet[
        game.currentQuestionIndex
      ];

    if (answer === 0 || answer === 1) {
      counts[answer]++;
    }
  }

  return counts;
}

function gameStateForGuest(clientId) {
  const answerSheet =
    game.answers[game.round].get(
      clientId
    );

  const ownAnswer =
    game.currentQuestionIndex !== null &&
    answerSheet
      ? answerSheet[
          game.currentQuestionIndex
        ]
      : null;

  const partner =
    getPartner(clientId);

  return {
    round: game.round,
    phase: game.phase,

    currentQuestionIndex:
      game.currentQuestionIndex,

    totalQuestions:
      getCurrentQuestions().length,

    question:
      getCurrentQuestionForGuest(),

    ownAnswer:
      ownAnswer ?? null,

    answerCounts:
      game.phase === "reveal"
        ? getCurrentAnswerCounts()
        : null,

    completedQuestions: [
      ...game.completedQuestions[
        game.round
      ]
    ],

    partner:
      game.round === 2 && partner
        ? {
            realName:
              partner.realName
          }
        : null,

    isMatched:
      Boolean(
        getParticipantPair(clientId)
      ),

    finished:
      game.phase === "finished"
  };
}

function gameStateForAdmin() {
  const question =
    game.currentQuestionIndex !== null
      ? getCurrentQuestions()[
          game.currentQuestionIndex
        ]
      : null;

  return {
    round: game.round,
    phase: game.phase,

    currentQuestionIndex:
      game.currentQuestionIndex,

    totalQuestions:
      getCurrentQuestions().length,

    questions:
      getCurrentQuestions(),

    question,

    answerCounts:
      getCurrentAnswerCounts(),

    answerTotal:
      getCurrentAnswerCounts().reduce(
        (sum, value) => sum + value,
        0
      ),

    completedQuestions: [
      ...game.completedQuestions[
        game.round
      ]
    ],

    participants:
      publicParticipantsForAdmin(),

    pairs:
      getPairResults(),

    unmatchedClientId:
      game.unmatchedClientId,

    winners:
      game.phase === "finished"
        ? getWinners()
        : []
  };
}

/*
|--------------------------------------------------------------------------
| Emit
|--------------------------------------------------------------------------
*/

function emitParticipantLists() {
  io.to("admin").emit(
    "participants:update",
    publicParticipantsForAdmin()
  );
}

function emitGameStateToAll() {
  io.to("admin").emit(
    "game:update",
    gameStateForAdmin()
  );

  for (
    const [clientId, participant]
    of participants.entries()
  ) {
    if (!participant.socketId) {
      continue;
    }

    io.to(participant.socketId).emit(
      "game:update",
      gameStateForGuest(clientId)
    );
  }
}

/*
|--------------------------------------------------------------------------
| QR / Join Info
|--------------------------------------------------------------------------
*/

app.get(
  "/api/join-info",
  async (_req, res) => {
    try {
      const joinUrl =
        `http://${getLanIp()}:${PORT}`;

      const qrDataUrl =
        await QRCode.toDataURL(
          joinUrl,
          {
            margin: 1,
            width: 320
          }
        );

      res.json({
        joinUrl,
        qrDataUrl
      });
    } catch (error) {
      console.error(
        "QR-Code konnte nicht erzeugt werden:",
        error
      );

      res.status(500).json({
        error:
          "QR-Code konnte nicht erzeugt werden."
      });
    }
  }
);

/*
|--------------------------------------------------------------------------
| Socket.IO
|--------------------------------------------------------------------------
*/

io.on("connection", (socket) => {
  /*
  |--------------------------------------------------------------------------
  | Admin
  |--------------------------------------------------------------------------
  */

  socket.on(
    "admin:join",
    (
      { key } = {},
      callback = () => {}
    ) => {
      if (key !== ADMIN_KEY) {
        callback({
          ok: false,
          error:
            "Falscher Admin-Schlüssel."
        });

        return;
      }

      socket.join("admin");
      socket.data.isAdmin = true;

      callback({
        ok: true,
        game: gameStateForAdmin(),
        participants:
          publicParticipantsForAdmin()
      });
    }
  );

  /*
  |--------------------------------------------------------------------------
  | Teilnehmer beitreten / wiederverbinden
  |--------------------------------------------------------------------------
  */

  socket.on(
    "participant:join",
    (
      {
        clientId,
        realName,
        pseudonym
      } = {},
      callback = () => {}
    ) => {
      clientId =
        normalizeName(clientId, 80);

      realName =
        normalizeName(realName);

      pseudonym =
        normalizeName(pseudonym);

      if (
        !clientId ||
        !realName ||
        !pseudonym
      ) {
        callback({
          ok: false,
          error:
            "Bitte echten Namen und Pseudonym vollständig eingeben."
        });

        return;
      }

      if (
        isPseudonymTaken(
          pseudonym,
          clientId
        )
      ) {
        callback({
          ok: false,
          error:
            "Dieses Pseudonym ist bereits vergeben."
        });

        return;
      }

      const existing =
        participants.get(clientId);

      participants.set(clientId, {
        clientId,
        realName,
        pseudonym,
        socketId: socket.id,
        connected: true
      });

      socket.data.clientId =
        clientId;

      ensureAnswerSheet(
        1,
        clientId
      );

      ensureAnswerSheet(
        2,
        clientId
      );

      saveGameState(
        existing
          ? "Teilnehmer wiederverbunden"
          : "Teilnehmer beigetreten"
      );

      callback({
        ok: true,

        participant: {
          clientId,
          pseudonym,
          realName
        },

        game:
          gameStateForGuest(clientId)
      });

      emitParticipantLists();
      emitGameStateToAll();
    }
  );

  /*
  |--------------------------------------------------------------------------
  | Antwort
  |--------------------------------------------------------------------------
  */

  socket.on(
    "participant:answer",
    (
      { optionIndex } = {},
      callback = () => {}
    ) => {
      const clientId =
        socket.data.clientId;

      if (
        !clientId ||
        !participants.has(clientId)
      ) {
        callback({
          ok: false,
          error:
            "Du bist nicht angemeldet."
        });

        return;
      }

      if (
        game.phase !== "question" ||
        game.currentQuestionIndex === null
      ) {
        callback({
          ok: false,
          error:
            "Aktuell kann nicht abgestimmt werden."
        });

        return;
      }

      if (
        optionIndex !== 0 &&
        optionIndex !== 1
      ) {
        callback({
          ok: false,
          error:
            "Ungültige Antwort."
        });

        return;
      }

      const answerSheet =
        ensureAnswerSheet(
          game.round,
          clientId
        );

      answerSheet[
        game.currentQuestionIndex
      ] = optionIndex;

      saveGameState(
        `Antwort Runde ${game.round}, Frage ${
          game.currentQuestionIndex + 1
        }`
      );

      callback({
        ok: true,
        optionIndex
      });

      emitGameStateToAll();
    }
  );

  /*
  |--------------------------------------------------------------------------
  | Frage starten
  |--------------------------------------------------------------------------
  */

  socket.on(
    "admin:startQuestion",
    (
      {
        key,
        questionIndex
      } = {},
      callback = () => {}
    ) => {
      if (
        !socket.data.isAdmin ||
        key !== ADMIN_KEY
      ) {
        callback({
          ok: false,
          error: "Nicht autorisiert."
        });

        return;
      }

      const questions =
        getCurrentQuestions();

      if (
        !Number.isInteger(
          questionIndex
        ) ||
        questionIndex < 0 ||
        questionIndex >=
          questions.length
      ) {
        callback({
          ok: false,
          error: "Ungültige Frage."
        });

        return;
      }

      game.currentQuestionIndex =
        questionIndex;

      game.phase = "question";

      saveGameState(
        `Frage ${questionIndex + 1} in Runde ${game.round} gestartet`
      );

      emitGameStateToAll();

      callback({
        ok: true
      });
    }
  );

  /*
  |--------------------------------------------------------------------------
  | Frage aufdecken
  |--------------------------------------------------------------------------
  */

  socket.on(
    "admin:reveal",
    (
      { key } = {},
      callback = () => {}
    ) => {
      if (
        !socket.data.isAdmin ||
        key !== ADMIN_KEY
      ) {
        callback({
          ok: false,
          error: "Nicht autorisiert."
        });

        return;
      }

      if (
        game.currentQuestionIndex === null
      ) {
        callback({
          ok: false,
          error:
            "Es läuft keine Frage."
        });

        return;
      }

      game.completedQuestions[
        game.round
      ].add(
        game.currentQuestionIndex
      );

      game.phase = "reveal";

      saveGameState(
        `Frage ${
          game.currentQuestionIndex + 1
        } in Runde ${game.round} aufgedeckt`
      );

      emitGameStateToAll();

      callback({
        ok: true
      });
    }
  );

  /*
  |--------------------------------------------------------------------------
  | Matching erzeugen
  |--------------------------------------------------------------------------
  */

  socket.on(
    "admin:createMatches",
    (
      { key } = {},
      callback = () => {}
    ) => {
      if (
        !socket.data.isAdmin ||
        key !== ADMIN_KEY
      ) {
        callback({
          ok: false,
          error: "Nicht autorisiert."
        });

        return;
      }

      if (
        game.round !== 1
      ) {
        callback({
          ok: false,
          error:
            "Matching ist nur nach Runde 1 möglich."
        });

        return;
      }

      if (
        game.completedQuestions[1]
          .size <
        round1Questions.length
      ) {
        callback({
          ok: false,
          error:
            "Bitte zuerst alle Fragen der Findungsrunde abschließen."
        });

        return;
      }

      createMatches();

      game.phase = "matching";
      game.currentQuestionIndex =
        null;

      saveGameState(
        "Matches gebildet"
      );

      emitGameStateToAll();

      callback({
        ok: true
      });
    }
  );

  /*
  |--------------------------------------------------------------------------
  | Runde 2 vorbereiten
  |--------------------------------------------------------------------------
  */

  socket.on(
    "admin:startRound2",
    (
      { key } = {},
      callback = () => {}
    ) => {
      if (
        !socket.data.isAdmin ||
        key !== ADMIN_KEY
      ) {
        callback({
          ok: false,
          error: "Nicht autorisiert."
        });

        return;
      }

      if (
        game.pairs.length === 0
      ) {
        callback({
          ok: false,
          error:
            "Es wurden noch keine Matches gebildet."
        });

        return;
      }

      game.round = 2;
      game.phase =
        "round2_ready";

      game.currentQuestionIndex =
        null;

      saveGameState(
        "Pärchenrunde vorbereitet"
      );

      emitGameStateToAll();

      callback({
        ok: true
      });
    }
  );

  /*
  |--------------------------------------------------------------------------
  | Spiel beenden
  |--------------------------------------------------------------------------
  */

  socket.on(
    "admin:finish",
    (
      { key } = {},
      callback = () => {}
    ) => {
      if (
        !socket.data.isAdmin ||
        key !== ADMIN_KEY
      ) {
        callback({
          ok: false,
          error: "Nicht autorisiert."
        });

        return;
      }

      if (
        game.round !== 2
      ) {
        callback({
          ok: false,
          error:
            "Das Finale ist erst nach der Pärchenrunde möglich."
        });

        return;
      }

      game.phase = "finished";
      game.currentQuestionIndex =
        null;

      saveGameState(
        "Spiel beendet"
      );

      emitGameStateToAll();

      callback({
        ok: true
      });
    }
  );

  /*
  |--------------------------------------------------------------------------
  | Disconnect
  |--------------------------------------------------------------------------
  */

  socket.on(
    "disconnect",
    () => {
      const clientId =
        socket.data.clientId;

      if (
        !clientId ||
        !participants.has(clientId)
      ) {
        return;
      }

      const participant =
        participants.get(clientId);

      if (
        participant.socketId !==
        socket.id
      ) {
        return;
      }

      participant.connected = false;
      participant.socketId = null;

      /*
       * connected/socketId müssen wir bewusst nicht persistieren.
       * Nach einem Server-Neustart sind sowieso zunächst alle offline.
       */

      emitParticipantLists();
    }
  );
});

/*
|--------------------------------------------------------------------------
| Graceful Shutdown
|--------------------------------------------------------------------------
*/

let isShuttingDown = false;

function shutdown(signal) {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;

  console.log(
    `\n${signal} empfangen. Speichere Spielstand ...`
  );

  saveGameState(
    `Server beendet (${signal})`
  );

  server.close(() => {
    console.log(
      "Server sauber beendet."
    );

    process.exit(0);
  });

  setTimeout(() => {
    console.error(
      "Server konnte nicht rechtzeitig sauber beendet werden."
    );

    process.exit(1);
  }, 3000).unref();
}

process.once(
  "SIGINT",
  () => shutdown("SIGINT")
);

process.once(
  "SIGTERM",
  () => shutdown("SIGTERM")
);

/*
|--------------------------------------------------------------------------
| Start
|--------------------------------------------------------------------------
*/

server.listen(
  PORT,
  "0.0.0.0",
  () => {
    const lanIp = getLanIp();

    console.log("");
    console.log(
      "Love-is-Phina läuft:"
    );

    console.log(
      `Gäste:  http://${lanIp}:${PORT}`
    );

    console.log(
      `Admin:  http://localhost:${PORT}/admin`
    );

    console.log("");

    if (recovery.exists()) {
      console.log(
        "[Recovery] Recovery-System aktiv."
      );
    }
  }
);