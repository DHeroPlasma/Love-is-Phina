const socket = io();

const adminLogin = document.querySelector("#adminLogin");
const dashboard = document.querySelector("#dashboard");
const adminForm = document.querySelector("#adminForm");
const adminKeyInput = document.querySelector("#adminKeyInput");
const adminError = document.querySelector("#adminError");

let adminKey = sessionStorage.getItem("weddingQuizAdminKey") || "";
let participants = [];
let game = null;

adminKeyInput.value = adminKey;

function loginAdmin() {
  if (!adminKey) return;

  socket.emit("admin:join", { key: adminKey }, (response) => {
    if (!response.ok) {
      adminError.textContent = response.error;
      adminLogin.classList.remove("hidden");
      dashboard.classList.add("hidden");
      return;
    }

    participants = response.participants;
    game = response.game;

    sessionStorage.setItem("weddingQuizAdminKey", adminKey);
    adminLogin.classList.add("hidden");
    dashboard.classList.remove("hidden");
    adminError.textContent = "";

    renderAll();
    loadJoinInfo();
  });
}

adminForm.addEventListener("submit", (event) => {
  event.preventDefault();
  adminKey = adminKeyInput.value;
  loginAdmin();
});

socket.on("connect", () => {
  document.querySelector("#connectionState").textContent = "verbunden";
  if (adminKey) loginAdmin();
});

socket.on("disconnect", () => {
  document.querySelector("#connectionState").textContent = "getrennt";
});

socket.on("participants:update", (nextParticipants) => {
  participants = nextParticipants;
  renderParticipants();
});

socket.on("game:update", (nextGame) => {
  game = nextGame;
  renderAll();
});

async function loadJoinInfo() {
  const response = await fetch("/api/join-info");
  const data = await response.json();

  document.querySelector("#qrCode").src = data.qrDataUrl;
  document.querySelector("#joinUrl").textContent = data.joinUrl;
}

function renderAll() {
  if (!game) return;
  renderHeader();
  renderParticipants();
  renderQuestions();
  renderStage();
  renderPairs();
}

function renderHeader() {
  const phaseLabels = {
    lobby: "Lobby",
    question: "Abstimmung läuft",
    reveal: "Aufgelöst",
    matching: "Matching",
    round2_ready: "Pärchen bereit",
    finished: "Finale"
  };

  document.querySelector("#roundHeading").textContent = game.roundLabel;
  document.querySelector("#phaseBadge").textContent = phaseLabels[game.phase] || game.phase;
  document.querySelector("#stageRound").textContent = game.roundLabel;

  document.querySelector("#answerCounter").textContent =
    game.phase === "question"
      ? `${game.answerTotal} Antwort${game.answerTotal === 1 ? "" : "en"}`
      : "";
}

function renderParticipants() {
  const element = document.querySelector("#participants");
  const count = document.querySelector("#participantCount");
  const privacyHint = document.querySelector("#privacyHint");

  const connectedCount = participants.filter((participant) => participant.connected).length;
  count.textContent = `(${connectedCount}/${participants.length})`;

  const namesRevealed = game && (game.round === 2 || ["matching", "round2_ready", "finished"].includes(game.phase));
  privacyHint.textContent = namesRevealed
    ? "Die Matches sind enthüllt – ab jetzt werden die echten Namen angezeigt."
    : "In der Findungsrunde bleiben die echten Namen auf der Leinwand verborgen.";

  if (!participants.length) {
    element.innerHTML = '<p class="muted">Noch niemand beigetreten.</p>';
    return;
  }

  element.innerHTML = [...participants]
    .sort((a, b) => a.displayName.localeCompare(b.displayName, "de"))
    .map((participant) => {
      const answered = game?.round === 2 ? participant.round2Answered : participant.round1Answered;
      return `
        <div class="participant-row">
          <div>
            <strong>${escapeHtml(participant.displayName)}</strong>
            ${participant.realName ? `<div class="muted small">Alias: ${escapeHtml(participant.pseudonym)}</div>` : ""}
          </div>
          <div class="participant-meta">
            <span class="muted small">${answered}/${game?.totalQuestions || 10}</span>
            <span class="status-dot ${participant.connected ? "online" : ""}"></span>
          </div>
        </div>
      `;
    })
    .join("");
}

function renderQuestions() {
  const title = document.querySelector("#questionListTitle");
  const progress = document.querySelector("#questionProgress");
  const element = document.querySelector("#questionList");
  const matchButton = document.querySelector("#matchButton");
  const finishButton = document.querySelector("#finishButton");

  title.textContent = `Fragen · ${game.roundLabel}`;
  progress.textContent = `${game.completedQuestions.length}/${game.totalQuestions} abgeschlossen`;

  const questionsLocked = ["matching", "finished"].includes(game.phase);

  element.innerHTML = game.questions
    .map((question, index) => {
      const completed = game.completedQuestions.includes(index);
      const active = game.currentQuestionIndex === index;
      return `
        <button class="question-item ${completed ? "completed" : ""} ${active ? "active" : ""}" data-index="${index}" type="button" ${questionsLocked ? "disabled" : ""}>
          <span>Frage ${index + 1}${completed ? " · ✓" : ""}</span>
          <strong>${escapeHtml(question.text)}</strong>
        </button>
      `;
    })
    .join("");

  element.querySelectorAll(".question-item").forEach((button) => {
    button.addEventListener("click", () => {
      const questionIndex = Number(button.dataset.index);
      socket.emit("admin:startQuestion", { key: adminKey, questionIndex }, showErrorIfNeeded);
    });
  });

  matchButton.classList.toggle("hidden", !(game.round === 1 && game.round1Complete && game.phase !== "matching"));
  finishButton.classList.toggle("hidden", !(game.round === 2 && game.round2Complete && game.phase !== "finished"));
}

function renderStage() {
  const empty = document.querySelector("#stageEmpty");
  const questionStage = document.querySelector("#stageQuestion");
  const matchingStage = document.querySelector("#matchingStage");
  const finalStage = document.querySelector("#finalStage");

  [empty, questionStage, matchingStage, finalStage].forEach((element) => element.classList.add("hidden"));

  if (game.phase === "finished") {
    finalStage.classList.remove("hidden");
    renderWinners();
    return;
  }

  if (game.phase === "matching") {
    matchingStage.classList.remove("hidden");
    return;
  }

  if (game.currentQuestionIndex === null || ["lobby", "round2_ready"].includes(game.phase)) {
    empty.classList.remove("hidden");
    document.querySelector("#emptyTitle").textContent =
      game.round === 1 ? "Die Findungsrunde kann beginnen." : "Die Pärchenrunde kann beginnen.";
    document.querySelector("#emptyText").textContent =
      game.round === 1
        ? "Zehn Fragen – die Gäste spielen ausschließlich unter ihrem Pseudonym."
        : "Die Matches stehen fest. Starte jetzt die erste Frage der Pärchenrunde.";
    return;
  }

  questionStage.classList.remove("hidden");
  document.querySelector("#stageQuestionText").textContent = game.question.text;

  document.querySelector("#stageOptions").innerHTML = game.question.options
    .map(
      (option, index) => `
        <div class="stage-option">
          <span>${index === 0 ? "A" : "B"}</span>
          <strong>${escapeHtml(option)}</strong>
        </div>
      `
    )
    .join("");

  const results = document.querySelector("#stageResults");

  if (game.phase === "reveal") {
    const counts = game.answerCounts || [0, 0];
    const total = Math.max(1, counts[0] + counts[1]);

    results.innerHTML = game.question.options
      .map((option, index) => {
        const percent = Math.round((counts[index] / total) * 100);
        return `
          <div class="result">
            <div class="result-label">
              <span>${escapeHtml(option)}</span>
              <strong>${counts[index]} · ${percent}%</strong>
            </div>
            <div class="bar"><div class="bar-fill" style="width:${percent}%"></div></div>
          </div>
        `;
      })
      .join("");
  } else {
    results.innerHTML = "";
  }

  document.querySelector("#revealButton").disabled = game.phase !== "question";
}

function renderPairs() {
  const card = document.querySelector("#pairsCard");
  const board = document.querySelector("#pairsBoard");
  const unmatchedBox = document.querySelector("#unmatchedBox");
  const status = document.querySelector("#pairRoundStatus");

  const shouldShow = game.pairs && game.pairs.length > 0;
  card.classList.toggle("hidden", !shouldShow);
  if (!shouldShow) return;

  status.textContent = game.round === 1 ? "Findungs-Match" : "Pärchen-Score";

  board.innerHTML = game.pairs
    .map((pair, index) => {
      const scoreText = game.round === 1
        ? `${pair.round1Agreement}/${game.totalQuestions} gleiche Antworten`
        : `${pair.round2Agreement}/${pair.round2Compared} Übereinstimmungen`;

      return `
        <div class="pair-row ${game.phase === "finished" && game.winners.some((winner) => winner.id === pair.id) ? "winner" : ""}">
          <div class="pair-seed">${index + 1}</div>
          <div class="person-node">${escapeHtml(pair.memberA.realName)}</div>
          <div class="pair-connector"><span>♥</span></div>
          <div class="person-node">${escapeHtml(pair.memberB.realName)}</div>
          <div class="pair-score">${scoreText}</div>
        </div>
      `;
    })
    .join("");

  unmatchedBox.innerHTML = game.unmatched
    ? `<div class="unmatched-note">Ohne Zweier-Match: <strong>${escapeHtml(game.unmatched.realName)}</strong> (${escapeHtml(game.unmatched.pseudonym)})</div>`
    : "";
}

function renderWinners() {
  const content = document.querySelector("#winnerContent");
  const title = document.querySelector("#winnerTitle");

  if (!game.winners.length) {
    title.textContent = "Noch kein Gewinnerpaar";
    content.innerHTML = "<p>Es konnten keine Paare ausgewertet werden.</p>";
    return;
  }

  title.textContent = game.winners.length > 1 ? "Gewinnerpaare – Gleichstand! 🏆" : "Gewinnerpaar 🏆";
  content.innerHTML = game.winners
    .map(
      (pair) => `
        <div class="winner-pair">
          <strong>${escapeHtml(pair.memberA.realName)} &amp; ${escapeHtml(pair.memberB.realName)}</strong>
          <span>${pair.round2Agreement}/${game.totalQuestions} Übereinstimmungen</span>
        </div>
      `
    )
    .join("");
}

function showErrorIfNeeded(response) {
  if (!response.ok) alert(response.error);
}

document.querySelector("#revealButton").addEventListener("click", () => {
  socket.emit("admin:reveal", { key: adminKey }, showErrorIfNeeded);
});

document.querySelector("#matchButton").addEventListener("click", () => {
  socket.emit("admin:createMatches", { key: adminKey }, showErrorIfNeeded);
});

document.querySelector("#startRound2Button").addEventListener("click", () => {
  socket.emit("admin:startRound2", { key: adminKey }, showErrorIfNeeded);
});

document.querySelector("#finishButton").addEventListener("click", () => {
  socket.emit("admin:finish", { key: adminKey }, showErrorIfNeeded);
});

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
