const socket = io();

const loginCard = document.querySelector("#loginCard");
const gameCard = document.querySelector("#gameCard");
const joinForm = document.querySelector("#joinForm");
const realNameInput = document.querySelector("#realName");
const pseudonymInput = document.querySelector("#pseudonym");
const loginError = document.querySelector("#loginError");
const playerName = document.querySelector("#playerName");
const progress = document.querySelector("#progress");

const views = {
  lobby: document.querySelector("#lobbyView"),
  question: document.querySelector("#questionView"),
  reveal: document.querySelector("#revealView"),
  finished: document.querySelector("#finishedView")
};

let clientId = localStorage.getItem("weddingQuizClientId");

if (!clientId) {
  clientId =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `guest-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  localStorage.setItem("weddingQuizClientId", clientId);
}

let savedProfile = null;

try {
  savedProfile = JSON.parse(localStorage.getItem("weddingQuizProfile") || "null");
} catch {
  savedProfile = null;
}

if (savedProfile) {
  realNameInput.value = savedProfile.realName || "";
  pseudonymInput.value = savedProfile.pseudonym || "";
}

function showView(name) {
  Object.entries(views).forEach(([key, element]) => {
    element.classList.toggle("hidden", key !== name);
  });
}

function renderGame(state) {
  if (!state) return;

  progress.textContent =
    state.currentQuestionIndex === null
      ? ""
      : `Frage ${state.currentQuestionIndex + 1} / ${state.totalQuestions}`;

  if (state.phase === "lobby") {
    showView("lobby");
    return;
  }

  if (state.phase === "finished") {
    showView("finished");
    return;
  }

  if (state.phase === "question") {
    showView("question");

    document.querySelector("#questionText").textContent = state.question.text;
    const options = document.querySelector("#options");
    const status = document.querySelector("#answerStatus");

    options.innerHTML = "";

    state.question.options.forEach((option, optionIndex) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "answer-button";
      button.textContent = option;

      if (state.ownAnswer === optionIndex) {
        button.classList.add("selected");
      }

      button.addEventListener("click", () => {
        socket.emit(
          "participant:answer",
          { optionIndex },
          (response) => {
            if (!response.ok) {
              status.textContent = response.error;
              return;
            }

            [...options.children].forEach((child, index) => {
              child.classList.toggle("selected", index === optionIndex);
            });

            status.textContent = "Antwort gespeichert ✓";
          }
        );
      });

      options.appendChild(button);
    });

    status.textContent =
      state.ownAnswer === null
        ? "Du kannst deine Auswahl bis zur Auflösung noch ändern."
        : "Antwort gespeichert ✓";

    return;
  }

  if (state.phase === "reveal") {
    showView("reveal");

    document.querySelector("#revealQuestion").textContent = state.question.text;

    const counts = state.answerCounts || [0, 0];
    const total = Math.max(1, counts[0] + counts[1]);
    const resultBars = document.querySelector("#resultBars");

    resultBars.innerHTML = state.question.options
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

    const correct = document.querySelector("#correctAnswer");

    correct.textContent =
      state.correctOption === 0 || state.correctOption === 1
        ? `Richtige Antwort: ${state.question.options[state.correctOption]}`
        : "";

    return;
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function joinGame(profile) {
  socket.emit(
    "participant:join",
    {
      clientId,
      realName: profile.realName,
      pseudonym: profile.pseudonym
    },
    (response) => {
      if (!response.ok) {
        loginError.textContent = response.error;
        loginCard.classList.remove("hidden");
        gameCard.classList.add("hidden");
        return;
      }

      savedProfile = profile;
      localStorage.setItem("weddingQuizProfile", JSON.stringify(profile));

      playerName.textContent = response.participant.pseudonym;
      loginCard.classList.add("hidden");
      gameCard.classList.remove("hidden");
      loginError.textContent = "";

      renderGame(response.game);
    }
  );
}

joinForm.addEventListener("submit", (event) => {
  event.preventDefault();

  joinGame({
    realName: realNameInput.value.trim(),
    pseudonym: pseudonymInput.value.trim()
  });
});

socket.on("connect", () => {
  if (savedProfile) {
    joinGame(savedProfile);
  }
});

socket.on("game:update", renderGame);
