require("dotenv").config();

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const QRCode = require("qrcode");
const os = require("os");
const path = require("path");

const RecoveryService = require("./services/RecoveryService");

// Current project filenames.
const round1Questions = require("./data/matching_round.json");
const round2Questions = require("./data/dating_round.json");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = Number(process.env.PORT || 3000);
const ADMIN_KEY = process.env.ADMIN_KEY || "hochzeit2026";
const PUBLIC_URL = process.env.PUBLIC_URL || null;

app.use(express.static(path.join(__dirname, "public")));

app.get("/admin", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

/* -------------------------------------------------------------------------- */
/* Recovery                                                                   */
/* -------------------------------------------------------------------------- */

const recovery = new RecoveryService({
  stateFile: path.join(__dirname, "data", "game-state.json"),
  backupFile: path.join(__dirname, "data", "game-state.backup.json"),
  tempFile: path.join(__dirname, "data", "game-state.tmp.json")
});

/* -------------------------------------------------------------------------- */
/* Game state                                                                 */
/* -------------------------------------------------------------------------- */

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

/* -------------------------------------------------------------------------- */
/* General helpers                                                            */
/* -------------------------------------------------------------------------- */

function getQuestionsForRound(round) {
  return round === 2
    ? round2Questions
    : round1Questions;
}

function getCurrentQuestions() {
  return getQuestionsForRound(game.round);
}

function getRoundLabel(round = game.round) {
  return round === 2
    ? "Pärchenrunde"
    : "Findungsrunde";
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

function isPseudonymTaken(
  pseudonym,
  ownClientId = null
) {
  const normalized =
    pseudonym.toLocaleLowerCase("de-DE");

  return [...participants.values()].some(
    (participant) =>
      participant.clientId !== ownClientId &&
      participant.pseudonym.toLocaleLowerCase(
        "de-DE"
      ) === normalized
  );
}

function ensureAnswerSheet(
  round,
  clientId
) {
  const expectedLength =
    getQuestionsForRound(round).length;

  const answerMap =
    game.answers[round];

  const existing =
    answerMap.get(clientId);

  if (
    !Array.isArray(existing) ||
    existing.length !== expectedLength
  ) {
    const normalized =
      new Array(expectedLength).fill(null);

    if (Array.isArray(existing)) {
      for (
        let index = 0;
        index <
        Math.min(
          existing.length,
          expectedLength
        );
        index++
      ) {
        if (
          existing[index] === 0 ||
          existing[index] === 1
        ) {
          normalized[index] =
            existing[index];
        }
      }
    }

    answerMap.set(
      clientId,
      normalized
    );
  }

  return answerMap.get(clientId);
}

function countAnswered(
  round,
  clientId
) {
  const sheet =
    ensureAnswerSheet(
      round,
      clientId
    );

  return sheet.filter(
    (answer) =>
      answer === 0 ||
      answer === 1
  ).length;
}

function getParticipantPair(
  clientId
) {
  return game.pairs.find(
    (pair) =>
      pair.memberA === clientId ||
      pair.memberB === clientId
  );
}

function getPartner(clientId) {
  const pair =
    getParticipantPair(clientId);

  if (!pair) {
    return null;
  }

  const partnerId =
    pair.memberA === clientId
      ? pair.memberB
      : pair.memberA;

  return (
    participants.get(partnerId) ||
    null
  );
}

function isUnmatched(clientId) {
  return Boolean(
    game.unmatchedClientId &&
    game.unmatchedClientId === clientId
  );
}

/* -------------------------------------------------------------------------- */
/* Persistence mapping                                                        */
/* -------------------------------------------------------------------------- */

function buildPersistentState() {
  return {
    version: 1,

    participants:
      [...participants.values()].map(
        (participant) => ({
          clientId:
            participant.clientId,

          realName:
            participant.realName,

          pseudonym:
            participant.pseudonym
        })
      ),

    game: {
      round:
        game.round,

      phase:
        game.phase,

      currentQuestionIndex:
        game.currentQuestionIndex,

      answers: {
        1: Object.fromEntries(
          game.answers[1]
        ),

        2: Object.fromEntries(
          game.answers[2]
        )
      },

      completedQuestions: {
        1: [
          ...game.completedQuestions[1]
        ],

        2: [
          ...game.completedQuestions[2]
        ]
      },

      pairs:
        game.pairs,

      unmatchedClientId:
        game.unmatchedClientId
    }
  };
}

function saveGameState(reason) {
  recovery.save(
    buildPersistentState(),
    reason
  );
}

function isValidAnswerSheet(
  value,
  expectedLength
) {
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

function normalizeRecoveredPair(
  pair,
  index
) {
  if (
    !pair ||
    !participants.has(pair.memberA) ||
    !participants.has(pair.memberB)
  ) {
    return null;
  }

  return {
    id:
      pair.id ||
      `pair-${index + 1}`,

    memberA:
      pair.memberA,

    memberB:
      pair.memberB,

    round1Agreement:
      Number.isInteger(
        pair.round1Agreement
      )
        ? pair.round1Agreement
        : Number.isInteger(
          pair.round1Matches
        )
          ? pair.round1Matches
          : 0,

    round1Compared:
      Number.isInteger(
        pair.round1Compared
      )
        ? pair.round1Compared
        : 0
  };
}

function restoreGameState(
  savedState
) {
  if (
    !savedState ||
    savedState.version !== 1 ||
    !savedState.game
  ) {
    throw new Error(
      "Ungültiger Recovery-Spielstand."
    );
  }

  participants.clear();

  for (
    const savedParticipant
    of savedState.participants || []
  ) {
    if (
      !savedParticipant.clientId ||
      !savedParticipant.realName ||
      !savedParticipant.pseudonym
    ) {
      continue;
    }

    participants.set(
      savedParticipant.clientId,
      {
        clientId:
          savedParticipant.clientId,

        realName:
          savedParticipant.realName,

        pseudonym:
          savedParticipant.pseudonym,

        socketId: null,
        connected: false
      }
    );
  }

  game.round =
    savedState.game.round === 2
      ? 2
      : 1;

  const validPhases =
    new Set([
      "lobby",
      "question",
      "reveal",
      "matching",
      "round2_ready",
      "finished"
    ]);

  game.phase =
    validPhases.has(
      savedState.game.phase
    )
      ? savedState.game.phase
      : "lobby";

  const currentQuestions =
    getQuestionsForRound(
      game.round
    );

  game.currentQuestionIndex =
    Number.isInteger(
      savedState.game
        .currentQuestionIndex
    ) &&
      savedState.game
        .currentQuestionIndex >= 0 &&
      savedState.game
        .currentQuestionIndex <
      currentQuestions.length
      ? savedState.game
        .currentQuestionIndex
      : null;

  game.answers[1].clear();
  game.answers[2].clear();

  for (
    const round
    of [1, 2]
  ) {
    const sourceAnswers =
      savedState.game
        .answers?.[round] || {};

    const expectedLength =
      getQuestionsForRound(
        round
      ).length;

    for (
      const clientId
      of participants.keys()
    ) {
      const storedSheet =
        sourceAnswers[
        clientId
        ];

      game.answers[
        round
      ].set(
        clientId,

        isValidAnswerSheet(
          storedSheet,
          expectedLength
        )
          ? [...storedSheet]
          : new Array(
            expectedLength
          ).fill(null)
      );
    }
  }

  const completedRound1 =
    Array.isArray(
      savedState.game
        .completedQuestions?.[1]
    )
      ? savedState.game
        .completedQuestions[1]
      : [];

  const completedRound2 =
    Array.isArray(
      savedState.game
        .completedQuestions?.[2]
    )
      ? savedState.game
        .completedQuestions[2]
      : [];

  game.completedQuestions[1] =
    new Set(
      completedRound1.filter(
        (index) =>
          Number.isInteger(index) &&
          index >= 0 &&
          index <
          round1Questions.length
      )
    );

  game.completedQuestions[2] =
    new Set(
      completedRound2.filter(
        (index) =>
          Number.isInteger(index) &&
          index >= 0 &&
          index <
          round2Questions.length
      )
    );

  game.pairs =
    Array.isArray(
      savedState.game.pairs
    )
      ? savedState.game.pairs
        .map(
          normalizeRecoveredPair
        )
        .filter(Boolean)
      : [];

  game.unmatchedClientId =
    savedState.game
      .unmatchedClientId &&
      participants.has(
        savedState.game
          .unmatchedClientId
      )
      ? savedState.game
        .unmatchedClientId
      : null;
}

/* -------------------------------------------------------------------------- */
/* Load recovery                                                              */
/* -------------------------------------------------------------------------- */

try {
  const savedState =
    recovery.load();

  if (savedState) {
    restoreGameState(
      savedState
    );

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

/* -------------------------------------------------------------------------- */
/* Matching                                                                   */
/* -------------------------------------------------------------------------- */

function calculateCompatibility(
  clientIdA,
  clientIdB
) {
  const answersA =
    ensureAnswerSheet(
      1,
      clientIdA
    );

  const answersB =
    ensureAnswerSheet(
      1,
      clientIdB
    );

  let matches = 0;
  let compared = 0;

  for (
    let index = 0;
    index <
    round1Questions.length;
    index++
  ) {
    const answerA =
      answersA[index];

    const answerB =
      answersB[index];

    if (
      (
        answerA !== 0 &&
        answerA !== 1
      ) ||
      (
        answerB !== 0 &&
        answerB !== 1
      )
    ) {
      continue;
    }

    compared++;

    if (
      answerA === answerB
    ) {
      matches++;
    }
  }

  return {
    matches,
    compared
  };
}

function createMatches() {
  const clientIds =
    [...participants.keys()];

  const combinations = [];

  for (
    let firstIndex = 0;
    firstIndex <
    clientIds.length;
    firstIndex++
  ) {
    for (
      let secondIndex =
        firstIndex + 1;
      secondIndex <
      clientIds.length;
      secondIndex++
    ) {
      const memberA =
        clientIds[firstIndex];

      const memberB =
        clientIds[secondIndex];

      const compatibility =
        calculateCompatibility(
          memberA,
          memberB
        );

      combinations.push({
        memberA,
        memberB,

        matchingScore:
          compatibility.matches,

        comparedAnswers:
          compatibility.compared
      });
    }
  }

  combinations.sort(
    (a, b) => {
      if (
        b.matchingScore !==
        a.matchingScore
      ) {
        return (
          b.matchingScore -
          a.matchingScore
        );
      }

      if (
        b.comparedAnswers !==
        a.comparedAnswers
      ) {
        return (
          b.comparedAnswers -
          a.comparedAnswers
        );
      }

      return `${a.memberA}:${a.memberB}`
        .localeCompare(
          `${b.memberA}:${b.memberB}`
        );
    }
  );

  const alreadyMatched =
    new Set();

  const pairs = [];

  for (
    const combination
    of combinations
  ) {
    if (
      alreadyMatched.has(
        combination.memberA
      ) ||
      alreadyMatched.has(
        combination.memberB
      )
    ) {
      continue;
    }

    pairs.push({
      id:
        `pair-${pairs.length + 1}`,

      memberA:
        combination.memberA,

      memberB:
        combination.memberB,

      round1Agreement:
        combination.matchingScore,

      round1Compared:
        combination.comparedAnswers
    });

    alreadyMatched.add(
      combination.memberA
    );

    alreadyMatched.add(
      combination.memberB
    );
  }

  game.pairs = pairs;

  game.unmatchedClientId =
    clientIds.find(
      (clientId) =>
        !alreadyMatched.has(
          clientId
        )
    ) || null;
}

/* -------------------------------------------------------------------------- */
/* Pair scoring                                                               */
/* -------------------------------------------------------------------------- */

function calculatePairRound2Score(
  pair
) {
  const answersA =
    ensureAnswerSheet(
      2,
      pair.memberA
    );

  const answersB =
    ensureAnswerSheet(
      2,
      pair.memberB
    );

  let matches = 0;
  let compared = 0;

  for (
    let index = 0;
    index <
    round2Questions.length;
    index++
  ) {
    if (
      !game.completedQuestions[2]
        .has(index)
    ) {
      continue;
    }

    const answerA =
      answersA[index];

    const answerB =
      answersB[index];

    if (
      (
        answerA !== 0 &&
        answerA !== 1
      ) ||
      (
        answerB !== 0 &&
        answerB !== 1
      )
    ) {
      continue;
    }

    compared++;

    if (
      answerA === answerB
    ) {
      matches++;
    }
  }

  return {
    matches,
    compared
  };
}

function getPairResults() {
  const results =
    game.pairs.map(
      (pair, index) => {
        const memberA =
          participants.get(
            pair.memberA
          );

        const memberB =
          participants.get(
            pair.memberB
          );

        const round2 =
          calculatePairRound2Score(
            pair
          );

        return {
          id:
            pair.id ||
            `pair-${index + 1}`,

          memberA: {
            clientId:
              pair.memberA,

            realName:
              memberA?.realName ||
              "Unbekannt",

            pseudonym:
              memberA?.pseudonym ||
              "?"
          },

          memberB: {
            clientId:
              pair.memberB,

            realName:
              memberB?.realName ||
              "Unbekannt",

            pseudonym:
              memberB?.pseudonym ||
              "?"
          },

          round1Agreement:
            Number.isInteger(
              pair.round1Agreement
            )
              ? pair.round1Agreement
              : Number.isInteger(
                pair.round1Matches
              )
                ? pair.round1Matches
                : 0,

          round1Compared:
            Number.isInteger(
              pair.round1Compared
            )
              ? pair.round1Compared
              : 0,

          round2Agreement:
            round2.matches,

          round2Compared:
            round2.compared
        };
      }
    );

  return results.sort(
    (a, b) => {
      if (
        game.round === 2 ||
        game.phase === "finished"
      ) {
        if (
          b.round2Agreement !==
          a.round2Agreement
        ) {
          return (
            b.round2Agreement -
            a.round2Agreement
          );
        }

        if (
          b.round2Compared !==
          a.round2Compared
        ) {
          return (
            b.round2Compared -
            a.round2Compared
          );
        }
      } else {
        if (
          b.round1Agreement !==
          a.round1Agreement
        ) {
          return (
            b.round1Agreement -
            a.round1Agreement
          );
        }

        if (
          b.round1Compared !==
          a.round1Compared
        ) {
          return (
            b.round1Compared -
            a.round1Compared
          );
        }
      }

      return a.id.localeCompare(
        b.id
      );
    }
  );
}

function getWinners() {
  const results =
    getPairResults();

  if (
    results.length === 0
  ) {
    return [];
  }

  const highestScore =
    Math.max(
      ...results.map(
        (pair) =>
          pair.round2Agreement
      )
    );

  return results.filter(
    (pair) =>
      pair.round2Agreement ===
      highestScore
  );
}

/* -------------------------------------------------------------------------- */
/* Public state                                                               */
/* -------------------------------------------------------------------------- */

function shouldRevealRealNames() {
  return (
    game.round === 2 ||
    game.phase === "matching" ||
    game.phase === "round2_ready" ||
    game.phase === "finished"
  );
}

function publicParticipantsForAdmin() {
  const revealRealNames =
    shouldRevealRealNames();

  return [
    ...participants.values()
  ].map(
    (participant) => ({
      clientId:
        participant.clientId,

      pseudonym:
        participant.pseudonym,

      realName:
        revealRealNames
          ? participant.realName
          : null,

      displayName:
        revealRealNames
          ? participant.realName
          : participant.pseudonym,

      connected:
        participant.connected,

      round1Answered:
        countAnswered(
          1,
          participant.clientId
        ),

      round2Answered:
        countAnswered(
          2,
          participant.clientId
        )
    })
  );
}

function getCurrentQuestionForGuest() {
  if (
    game.currentQuestionIndex ===
    null
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
    id:
      question.id,

    text:
      question.text,

    options:
      question.options
  };
}

function getCurrentAnswerCounts() {
  const counts =
    [0, 0];

  if (
    game.currentQuestionIndex ===
    null
  ) {
    return counts;
  }

  for (
    const [
      clientId,
      answerSheet
    ]
    of game.answers[
      game.round
    ].entries()
  ) {
    if (
      game.round === 2 &&
      isUnmatched(clientId)
    ) {
      continue;
    }

    const answer =
      answerSheet[
      game.currentQuestionIndex
      ];

    if (
      answer === 0 ||
      answer === 1
    ) {
      counts[answer]++;
    }
  }

  return counts;
}

function getUnmatchedPublic() {
  if (
    !game.unmatchedClientId
  ) {
    return null;
  }

  const participant =
    participants.get(
      game.unmatchedClientId
    );

  if (!participant) {
    return null;
  }

  return {
    clientId:
      participant.clientId,

    realName:
      participant.realName,

    pseudonym:
      participant.pseudonym
  };
}

function gameStateForGuest(
  clientId
) {
  const answerSheet =
    ensureAnswerSheet(
      game.round,
      clientId
    );

  const ownAnswer =
    game.currentQuestionIndex !==
      null
      ? answerSheet[
      game.currentQuestionIndex
      ]
      : null;

  const partner =
    getPartner(clientId);

  return {
    round:
      game.round,

    roundLabel:
      getRoundLabel(),

    phase:
      game.phase,

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
      partner &&
        shouldRevealRealNames()
        ? {
          realName:
            partner.realName
        }
        : null,

    isMatched:
      Boolean(
        getParticipantPair(
          clientId
        )
      ),

    isUnmatched:
      isUnmatched(clientId),

    finished:
      game.phase === "finished"
  };
}

function gameStateForAdmin() {
  const currentQuestions =
    getCurrentQuestions();

  const question =
    game.currentQuestionIndex !==
      null
      ? currentQuestions[
      game.currentQuestionIndex
      ] || null
      : null;

  const answerCounts =
    getCurrentAnswerCounts();

  return {
    round:
      game.round,

    roundLabel:
      getRoundLabel(),

    phase:
      game.phase,

    currentQuestionIndex:
      game.currentQuestionIndex,

    totalQuestions:
      currentQuestions.length,

    questions:
      currentQuestions,

    question,

    answerCounts,

    answerTotal:
      answerCounts.reduce(
        (sum, value) =>
          sum + value,
        0
      ),

    completedQuestions: [
      ...game.completedQuestions[
      game.round
      ]
    ],

    round1Complete:
      game.completedQuestions[1]
        .size ===
      round1Questions.length,

    round2Complete:
      game.completedQuestions[2]
        .size ===
      round2Questions.length,

    participants:
      publicParticipantsForAdmin(),

    pairs:
      getPairResults(),

    unmatched:
      getUnmatchedPublic(),

    unmatchedClientId:
      game.unmatchedClientId,

    winners:
      game.phase === "finished"
        ? getWinners()
        : []
  };
}

function resetGameState() {
  participants.clear();

  game.round = 1;
  game.phase = "lobby";
  game.currentQuestionIndex = null;

  game.answers[1].clear();
  game.answers[2].clear();

  game.completedQuestions[1].clear();
  game.completedQuestions[2].clear();

  game.pairs = [];
  game.unmatchedClientId = null;
}

/* -------------------------------------------------------------------------- */
/* Emit helpers                                                               */
/* -------------------------------------------------------------------------- */

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
    const [
      clientId,
      participant
    ]
    of participants.entries()
  ) {
    if (
      participant.socketId
    ) {
      io.to(
        participant.socketId
      ).emit(
        "game:update",
        gameStateForGuest(
          clientId
        )
      );
    }
  }
}

/* -------------------------------------------------------------------------- */
/* QR / join info                                                             */
/* -------------------------------------------------------------------------- */

app.get(
  "/api/join-info",
  async (_req, res) => {

    try {

      /*
        If a public Cloudflare URL is configured,
        use it for the guest QR code.

        Otherwise fall back to the local LAN address.
      */

      const joinUrl =
        PUBLIC_URL ||
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
        qrDataUrl,
        public: Boolean(PUBLIC_URL)
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

/* -------------------------------------------------------------------------- */
/* Socket.IO                                                                  */
/* -------------------------------------------------------------------------- */

io.on(
  "connection",
  (socket) => {

    /* ---------------------------------------------------------------------- */
    /* Admin login                                                            */
    /* ---------------------------------------------------------------------- */

    socket.on(
      "admin:join",
      (
        { key } = {},
        callback = () => { }
      ) => {
        if (
          key !== ADMIN_KEY
        ) {
          callback({
            ok: false,
            error:
              "Falscher Admin-Schlüssel."
          });

          return;
        }

        socket.join(
          "admin"
        );

        socket.data.isAdmin =
          true;

        callback({
          ok: true,

          game:
            gameStateForAdmin(),

          participants:
            publicParticipantsForAdmin()
        });
      }
    );

    /* ---------------------------------------------------------------------- */
    /* Participant join / reconnect                                           */
    /* ---------------------------------------------------------------------- */

    socket.on(
      "participant:join",
      (
        {
          clientId,
          realName,
          pseudonym
        } = {},
        callback = () => { }
      ) => {
        clientId =
          normalizeName(
            clientId,
            80
          );

        realName =
          normalizeName(
            realName
          );

        pseudonym =
          normalizeName(
            pseudonym
          );

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
          participants.get(
            clientId
          );

        participants.set(
          clientId,
          {
            clientId,
            realName,
            pseudonym,
            socketId:
              socket.id,
            connected:
              true
          }
        );

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
            gameStateForGuest(
              clientId
            )
        });

        emitParticipantLists();
        emitGameStateToAll();
      }
    );

    /* ---------------------------------------------------------------------- */
    /* Participant answer                                                     */
    /* ---------------------------------------------------------------------- */

    socket.on(
      "participant:answer",
      (
        { optionIndex } = {},
        callback = () => { }
      ) => {
        const clientId =
          socket.data.clientId;

        if (
          !clientId ||
          !participants.has(
            clientId
          )
        ) {
          callback({
            ok: false,
            error:
              "Du bist nicht angemeldet."
          });

          return;
        }

        if (
          game.phase !==
          "question" ||
          game.currentQuestionIndex ===
          null
        ) {
          callback({
            ok: false,
            error:
              "Aktuell kann nicht abgestimmt werden."
          });

          return;
        }

        if (
          game.round === 2 &&
          isUnmatched(
            clientId
          )
        ) {
          callback({
            ok: false,
            error:
              "Du verfolgst die Pärchenrunde als Zuschauer."
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
          `Antwort Runde ${game.round}, Frage ${game.currentQuestionIndex +
          1
          }`
        );

        callback({
          ok: true,
          optionIndex
        });

        emitGameStateToAll();
      }
    );

    /* ---------------------------------------------------------------------- */
    /* Start question                                                         */
    /* ---------------------------------------------------------------------- */

    socket.on(
      "admin:startQuestion",
      (
        {
          key,
          questionIndex
        } = {},
        callback = () => { }
      ) => {
        if (
          !socket.data.isAdmin ||
          key !== ADMIN_KEY
        ) {
          callback({
            ok: false,
            error:
              "Nicht autorisiert."
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
            error:
              "Ungültige Frage."
          });

          return;
        }

        if (
          [
            "matching",
            "finished"
          ].includes(
            game.phase
          )
        ) {
          callback({
            ok: false,
            error:
              "In dieser Spielphase kann keine Frage gestartet werden."
          });

          return;
        }

        game.currentQuestionIndex =
          questionIndex;

        game.phase =
          "question";

        saveGameState(
          `Frage ${questionIndex + 1
          } in Runde ${game.round
          } gestartet`
        );

        emitGameStateToAll();

        callback({
          ok: true
        });
      }
    );

    /* ---------------------------------------------------------------------- */
    /* Reveal question                                                        */
    /* ---------------------------------------------------------------------- */

    socket.on(
      "admin:reveal",
      (
        { key } = {},
        callback = () => { }
      ) => {
        if (
          !socket.data.isAdmin ||
          key !== ADMIN_KEY
        ) {
          callback({
            ok: false,
            error:
              "Nicht autorisiert."
          });

          return;
        }

        if (
          game.phase !==
          "question" ||
          game.currentQuestionIndex ===
          null
        ) {
          callback({
            ok: false,
            error:
              "Es läuft keine aktive Frage."
          });

          return;
        }

        game.completedQuestions[
          game.round
        ].add(
          game.currentQuestionIndex
        );

        game.phase =
          "reveal";

        saveGameState(
          `Frage ${game.currentQuestionIndex +
          1
          } in Runde ${game.round
          } aufgedeckt`
        );

        emitGameStateToAll();

        callback({
          ok: true
        });
      }
    );

    /* ---------------------------------------------------------------------- */
    /* Create matches                                                         */
    /* ---------------------------------------------------------------------- */

    socket.on(
      "admin:createMatches",
      (
        { key } = {},
        callback = () => { }
      ) => {
        if (
          !socket.data.isAdmin ||
          key !== ADMIN_KEY
        ) {
          callback({
            ok: false,
            error:
              "Nicht autorisiert."
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
            .size !==
          round1Questions.length
        ) {
          callback({
            ok: false,
            error:
              "Bitte zuerst alle Fragen der Findungsrunde abschließen."
          });

          return;
        }

        if (
          participants.size < 2
        ) {
          callback({
            ok: false,
            error:
              "Für das Matching werden mindestens zwei Teilnehmer benötigt."
          });

          return;
        }

        createMatches();

        game.phase =
          "matching";

        game.currentQuestionIndex =
          null;

        saveGameState(
          "Matches gebildet"
        );

        emitGameStateToAll();
        emitParticipantLists();

        callback({
          ok: true
        });
      }
    );

    /* ---------------------------------------------------------------------- */
    /* Start round 2                                                          */
    /* ---------------------------------------------------------------------- */

    socket.on(
      "admin:startRound2",
      (
        { key } = {},
        callback = () => { }
      ) => {
        if (
          !socket.data.isAdmin ||
          key !== ADMIN_KEY
        ) {
          callback({
            ok: false,
            error:
              "Nicht autorisiert."
          });

          return;
        }

        if (
          game.phase !==
          "matching" ||
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
        emitParticipantLists();

        callback({
          ok: true
        });
      }
    );

    /* ---------------------------------------------------------------------- */
    /* Finish game                                                            */
    /* ---------------------------------------------------------------------- */

    socket.on(
      "admin:finish",
      (
        { key } = {},
        callback = () => { }
      ) => {
        if (
          !socket.data.isAdmin ||
          key !== ADMIN_KEY
        ) {
          callback({
            ok: false,
            error:
              "Nicht autorisiert."
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

        if (
          game.completedQuestions[2]
            .size !==
          round2Questions.length
        ) {
          callback({
            ok: false,
            error:
              "Bitte zuerst alle Fragen der Pärchenrunde abschließen."
          });

          return;
        }

        game.phase =
          "finished";

        game.currentQuestionIndex =
          null;

        saveGameState(
          "Spiel beendet"
        );

        emitGameStateToAll();
        emitParticipantLists();

        callback({
          ok: true
        });
      }
    );

    /* -------------------------------------------------------------------------- */
    /* Game reset                                                                 */
    /* -------------------------------------------------------------------------- */

    socket.on(
      "admin:resetGame",
      (
        { key } = {},
        callback = () => { }
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

        // Remove recovery files first.
        recovery.clear();

        // Reset the complete in-memory game state.
        resetGameState();

        // Remove participant associations from all guest sockets.
        for (
          const connectedSocket
          of io.sockets.sockets.values()
        ) {
          if (!connectedSocket.data.isAdmin) {
            connectedSocket.data.clientId = null;
          }
        }

        // Tell every connected guest to clear localStorage
        // and return to the registration screen.
        io.emit("game:reset");

        const freshGame =
          gameStateForAdmin();

        const freshParticipants =
          publicParticipantsForAdmin();

        // Update all connected admin views.
        io.to("admin").emit(
          "participants:update",
          freshParticipants
        );

        io.to("admin").emit(
          "game:update",
          freshGame
        );

        callback({
          ok: true,
          game: freshGame,
          participants: freshParticipants
        });
      }
    );

    /* ---------------------------------------------------------------------- */
    /* Disconnect                                                             */
    /* ---------------------------------------------------------------------- */

    socket.on(
      "disconnect",
      () => {
        const clientId =
          socket.data.clientId;

        if (
          !clientId ||
          !participants.has(
            clientId
          )
        ) {
          return;
        }

        const participant =
          participants.get(
            clientId
          );

        /*
          Ignore disconnects from old sockets if the same guest
          has already reconnected using a newer socket.
        */
        if (
          participant.socketId !==
          socket.id
        ) {
          return;
        }

        participant.connected =
          false;

        participant.socketId =
          null;

        emitParticipantLists();
      }
    );
  }
);

/* -------------------------------------------------------------------------- */
/* Graceful shutdown                                                          */
/* -------------------------------------------------------------------------- */

let isShuttingDown =
  false;

function shutdown(signal) {
  if (
    isShuttingDown
  ) {
    return;
  }

  isShuttingDown =
    true;

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
  () =>
    shutdown("SIGINT")
);

process.once(
  "SIGTERM",
  () =>
    shutdown("SIGTERM")
);

/* -------------------------------------------------------------------------- */
/* Start                                                                      */
/* -------------------------------------------------------------------------- */

server.listen(
  PORT,
  "0.0.0.0",
  () => {

    const lanUrl =
      `http://${getLanIp()}:${PORT}`;

    console.log("");
    console.log(
      "Love-is-Phina läuft:"
    );

    console.log(
      `Lokal:  ${lanUrl}`
    );

    if (PUBLIC_URL) {
      console.log(
        `Public: ${PUBLIC_URL}`
      );
    }

    console.log(
      `Admin:  http://localhost:${PORT}/admin`
    );

    console.log("");
  }
);