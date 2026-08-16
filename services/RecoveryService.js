const fs = require("fs");
const path = require("path");

class RecoveryService {
  constructor({ stateFile, backupFile, tempFile }) {
    if (!stateFile || !backupFile || !tempFile) {
      throw new Error(
        "RecoveryService benötigt stateFile, backupFile und tempFile."
      );
    }

    this.stateFile = stateFile;
    this.backupFile = backupFile;
    this.tempFile = tempFile;
  }

  save(state, reason = "Änderung") {
    try {
      const payload = {
        ...state,
        savedAt: new Date().toISOString()
      };

      const json = JSON.stringify(payload, null, 2);

      this.ensureDirectoryExists();

      // Erst vollständig in temporäre Datei schreiben.
      fs.writeFileSync(this.tempFile, json, "utf8");

      // Letzten gültigen Stand als Backup sichern.
      if (fs.existsSync(this.stateFile)) {
        fs.copyFileSync(this.stateFile, this.backupFile);
      }

      // Temp-Datei atomar zur eigentlichen State-Datei machen.
      fs.renameSync(this.tempFile, this.stateFile);

      console.log(`[Recovery] Spielstand gespeichert (${reason}).`);

      return true;
    } catch (error) {
      console.error(
        "[Recovery] Spielstand konnte nicht gespeichert werden:",
        error
      );

      return false;
    }
  }

  load() {
    const candidates = [
      {
        file: this.stateFile,
        type: "Hauptdatei"
      },
      {
        file: this.backupFile,
        type: "Backup"
      }
    ];

    for (const candidate of candidates) {
      if (!fs.existsSync(candidate.file)) {
        continue;
      }

      try {
        const content = fs.readFileSync(candidate.file, "utf8");
        const state = JSON.parse(content);

        console.log(
          `[Recovery] Spielstand aus ${candidate.type} geladen: ${path.basename(
            candidate.file
          )}`
        );

        if (state.savedAt) {
          console.log(`[Recovery] Gespeichert am: ${state.savedAt}`);
        }

        return state;
      } catch (error) {
        console.error(
          `[Recovery] ${candidate.type} konnte nicht geladen werden:`,
          error.message
        );
      }
    }

    console.log(
      "[Recovery] Kein gültiger gespeicherter Spielstand gefunden."
    );

    return null;
  }

  exists() {
    return (
      fs.existsSync(this.stateFile) ||
      fs.existsSync(this.backupFile)
    );
  }

  clear() {
    const files = [
      this.stateFile,
      this.backupFile,
      this.tempFile
    ];

    for (const file of files) {
      try {
        if (fs.existsSync(file)) {
          fs.unlinkSync(file);
        }
      } catch (error) {
        console.error(
          `[Recovery] Datei konnte nicht gelöscht werden: ${file}`,
          error
        );
      }
    }

    console.log("[Recovery] Gespeicherter Spielstand wurde gelöscht.");
  }

  ensureDirectoryExists() {
    const directory = path.dirname(this.stateFile);

    fs.mkdirSync(directory, {
      recursive: true
    });
  }
}

module.exports = RecoveryService;