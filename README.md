# 💍 Love-is-Phina

An interactive wedding game loosely inspired by the concept of **Love Is Blind**.

Guests participate using their smartphones while the host controls the game from a laptop. The host view can be projected onto a screen using a projector.

The game consists of two rounds:

1. **Matching Round** – Guests play anonymously using pseudonyms.
2. **Couples Round** – Guests are matched based on their answers and continue playing as couples using their real names.
3. **Final** – The couple with the highest score in the couples round wins.

---

# Game Flow

## 1. Joining the Game

Guests open the game website on their smartphones.

They are asked to enter:

* their real name
* a pseudonym

During the Matching Round, only the pseudonym is displayed on the host screen.

Real names are revealed after the matching process.

---

## 2. Matching Round

The questions for the first round are stored in:

```text
data/round1.json
```

By default, the round consists of ten questions with two possible answers each.

Example:

```json
{
  "id": 1,
  "text": "The perfect vacation: beach or mountains?",
  "options": [
    "Beach",
    "Mountains"
  ]
}
```

Each guest answers the questions independently on their smartphone.

There are no correct or incorrect answers.

All answers are stored and later used by the matching algorithm.

---

## 3. Matching

After the Matching Round has been completed, the host can start the matching process.

The server compares every possible combination of participants.

Example:

```text
Anna ↔ Ben       6/10
Anna ↔ Clara     9/10
Anna ↔ Daniel    5/10
Ben ↔ Clara      4/10
Ben ↔ Daniel     8/10
Clara ↔ Daniel   3/10
```

The combinations are sorted by the number of matching answers.

Participants with the highest available compatibility are then paired together.

Example:

```text
Anna ♥ Clara
9/10 matching answers

Ben ♥ Daniel
8/10 matching answers
```

After the matching process, the participants' real names are revealed.

If there is an odd number of participants, one guest will remain without a partner.

---

## 4. Couples Round

The questions for the second round are stored in:

```text
data/round2.json
```

Both members of each couple continue answering independently on their own smartphones.

After each question is revealed, the server checks whether both members of a couple selected the same answer.

Example:

```text
Lukas → Sleep in
Julia → Sleep in

= Match
```

The couple receives one matching point.

If their answers differ:

```text
Lukas → Sleep in
Julia → Get up early

= No match
```

The current scores of all couples are displayed on the host screen.

Example:

```text
Lukas ♥ Julia       5/6
Max ♥ Sarah         4/6
Anna ♥ Tobias       3/6
```

---

## 5. Winner

After all questions in the Couples Round have been completed, the couple with the most matching answers wins.

If multiple couples have the same highest score, multiple winners can be displayed.

---

# Project Structure

```text
Love-is-Phina/
│
├── server.js
├── package.json
├── package-lock.json
├── .env
├── .env.example
├── .gitignore
├── README.md
│
├── services/
│   └── RecoveryService.js
│
├── data/
│   ├── round1.json
│   ├── round2.json
│   │
│   ├── game-state.json
│   ├── game-state.backup.json
│   └── game-state.tmp.json
│
└── public/
    ├── index.html
    ├── guest.js
    ├── admin.html
    ├── admin.js
    └── styles.css
```

The three `game-state` files are managed automatically by the recovery system and do not need to be created manually.

---

# Installation

Node.js must be installed on the host computer.

Inside the project directory, run:

```bash
npm install
```

When using Windows PowerShell, you can alternatively use:

```powershell
npm.cmd install
```

---

# Configuration

The file

```text
.env.example
```

can be used as a template for your local

```text
.env
```

file.

Example:

```env
PORT=3000
ADMIN_KEY=my-secret-admin-key
```

The `.env` file should not be committed to Git.

---

# Starting the Server

Inside the project directory, run:

```bash
npm start
```

When using PowerShell:

```powershell
npm.cmd start
```

The admin interface will then be available on the host laptop at:

```text
http://localhost:3000/admin
```

The URL for guests is automatically generated using the laptop's local IP address.

Example:

```text
http://192.168.178.34:3000
```

A QR code containing this URL is automatically displayed on the admin page.

---

# Network

The laptop and all smartphones must be connected to the same network.

For the wedding, using a shared Wi-Fi network is recommended.

If guests cannot access the game, check the following:

* The laptop and smartphones are connected to the same Wi-Fi network.
* The Windows Firewall allows Node.js or port `3000`.
* The Wi-Fi network does not use client isolation.
* The IP address shown by the game belongs to the host laptop.

Some guest Wi-Fi networks intentionally prevent direct communication between connected devices.

---

# Recovery System

To prevent the loss of participants, answers, matches, and game progress if the Node.js server crashes or is accidentally stopped, the project includes an automatic recovery system.

The responsible service is located at:

```text
services/RecoveryService.js
```

The `RecoveryService` is only responsible for storing and loading JSON data.

The actual game logic remains inside:

```text
server.js
```

This keeps persistence and game logic separated.

---

## What Is Stored?

The recovery state includes:

* participants
* real names
* pseudonyms
* Matching Round answers
* Couples Round answers
* completed questions
* current round
* current question
* current game phase
* generated couples
* an unmatched participant, if applicable

Temporary Socket.IO connections are not persisted.

---

## Automatic Saving

The game state is saved automatically after relevant changes.

This includes:

* a participant joining
* a participant reconnecting
* submitting or changing an answer
* starting a question
* revealing a question
* generating matches
* starting the Couples Round
* finishing the game

The game state is also saved when the server is stopped normally using:

```text
Ctrl+C
```

No manual save action is required during the game.

---

## `game-state.json`

The current game state is stored in:

```text
data/game-state.json
```

This file is created automatically.

A simplified example:

```json
{
  "version": 1,
  "savedAt": "2026-08-16T10:30:00.000Z",
  "participants": [],
  "game": {
    "round": 1,
    "phase": "question",
    "currentQuestionIndex": 3
  }
}
```

---

## Safe Writes

To reduce the risk of corrupting the recovery file if the server crashes while saving, the new game state is first written to a temporary file:

```text
data/game-state.tmp.json
```

Only after the file has been written successfully is it renamed to:

```text
data/game-state.json
```

This helps ensure that the primary recovery file always contains a fully written game state.

---

## Backup

Before replacing the existing game state, the previous version is copied to:

```text
data/game-state.backup.json
```

Under normal circumstances, the recovery files therefore represent:

```text
game-state.json
        │
        └── current game state

game-state.backup.json
        │
        └── previous game state
```

If the primary `game-state.json` cannot be read during startup, the `RecoveryService` automatically attempts to load the backup.

---

# Recovering After a Crash

For example, assume the game is currently at:

```text
Couples Round
Question 6/10
```

and the Node.js process unexpectedly stops.

Simply restart the server:

```bash
npm start
```

During startup, the `RecoveryService` automatically attempts to load:

```text
data/game-state.json
```

If the file contains a valid state, the game is restored.

The console will display a recovery message indicating that a saved state was loaded.

---

## Smartphone Reconnection

Each smartphone has a `clientId` stored locally in the browser.

After a server restart, all participants initially appear as offline.

When a guest reloads or reopens the game page, the browser sends its existing `clientId` back to the server.

The server can then associate the device with the participant's previous session.

Previously submitted answers remain available.

---

# Starting a New Game / Resetting Recovery

To start a completely new game, first stop the Node.js server:

```text
Ctrl+C
```

Then delete the following files if they exist:

```text
data/game-state.json
data/game-state.backup.json
data/game-state.tmp.json
```

Start the server again:

```bash
npm start
```

Because no recovery state exists, the server will start a completely new game.

Do **not** delete:

```text
data/round1.json
data/round2.json
```

These files contain the game's questions.

---

# Git and Recovery

Recovery files contain live data from a specific game session and should not be committed to the repository.

The `.gitignore` file should therefore contain:

```gitignore
node_modules/
.env

data/game-state.json
data/game-state.backup.json
data/game-state.tmp.json
```

Do **not** ignore the entire `data/` directory:

```gitignore
data/
```

Otherwise, the question files

```text
round1.json
round2.json
```

would also be excluded from version control.

---

# Recommended Test Before the Wedding

The complete recovery process should be tested under realistic conditions before the actual wedding.

A suggested test:

1. Start the server.
2. Connect at least two smartphones.
3. Answer several questions.
4. Reveal a question.
5. Stop the server using `Ctrl+C`.
6. Start the server again.
7. Reload the admin page.
8. Reload the smartphones.
9. Verify that participants, answers, and game progress have been restored.

It is also recommended to repeat this test after the matching process and during the Couples Round.

This ensures that the network, browsers, and recovery system work correctly on the laptop that will actually be used at the wedding.

---

# Technology

The project intentionally uses a simple technology stack:

* Node.js
* Express
* Socket.IO
* Vanilla JavaScript
* HTML
* CSS
* JSON

No external database is required.

The entire game can therefore run locally on a single laptop without requiring an internet connection.
