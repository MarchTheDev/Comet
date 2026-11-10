import { Download, ExternalLink, RefreshCw } from "lucide-react";
import {
  DEFAULT_UPDATE_PREFERENCES,
  type UpdateInfo,
  type UpdateInstallStep,
  type UpdatePreferences,
} from "./utils/updates";

export function UpdatesSettings({
  version,
  desktop,
  update,
  status,
  installStep = "idle",
  checking = false,
  preferences = DEFAULT_UPDATE_PREFERENCES,
  onPreferencesChange = () => {},
  onCheck,
  onInstall,
  onPage,
}: {
  version: string;
  desktop: boolean;
  update: UpdateInfo | null;
  status: string;
  installStep?: UpdateInstallStep;
  checking?: boolean;
  preferences?: UpdatePreferences;
  onPreferencesChange?: (next: UpdatePreferences) => void;
  onCheck: () => void;
  onInstall: () => void;
  onPage: (url?: string) => void;
}) {
  const activeAsset =
    update?.platformAsset ??
    (update?.installer ? { ...update.installer, platform: "windows" as const } : null);
  const canDirectInstall = Boolean(desktop && update && activeAsset);
  const busy = installStep !== "idle";
  const installLabel =
    installStep === "downloading"
      ? "Downloading…"
      : installStep === "opening"
        ? "Opening…"
        : update
          ? `Install ${update.version}`
          : "Install update";

  return (
    <section className="settings-card updates-card" aria-labelledby="updates-title">
      <div className="settings-card-heading">
        <div>
          <h2 id="updates-title">Updates</h2>
          <p>Check GitHub releases for new versions of Comet and install them with one click.</p>
        </div>
      </div>

      <div className="setting-row update-setting-row">
        <span className="setting-copy">
          <strong>Comet {version}</strong>
          <small role="status">
            {status ||
              (update
                ? `Comet ${update.version} is out and ready to install.`
                : "You're running the current build of Comet.")}
          </small>
        </span>
        <div className="update-actions">
          <button
            className="secondary-button"
            type="button"
            disabled={checking || busy}
            onClick={onCheck}
          >
            <RefreshCw size={15} className={checking ? "spin" : undefined} />{" "}
            {checking ? "Checking…" : "Check now"}
          </button>
          {update &&
            (canDirectInstall ? (
              <button
                className="primary-button"
                type="button"
                disabled={busy}
                onClick={onInstall}
              >
                <Download size={15} /> {installLabel}
              </button>
            ) : (
              <button
                className="primary-button"
                type="button"
                onClick={() => onPage(update.url)}
              >
                <ExternalLink size={15} /> Get {update.version}
              </button>
            ))}
          <button
            className="secondary-button"
            type="button"
            onClick={() => onPage(update?.url)}
          >
            <ExternalLink size={15} /> {update ? "Release notes" : "Releases"}
          </button>
        </div>
      </div>

      {update?.notes && (
        <div className="update-notes">
          <strong>
            What's in {update.version}
            {update.prerelease ? " (pre-release)" : ""}
          </strong>
          <p>{update.notes}</p>
        </div>
      )}

      <label className="setting-row">
        <span className="setting-copy">
          <strong id="update-check-launch-label">Look for a new version when Comet opens</strong>
          <small>Quietly checks GitHub releases shortly after startup and lets you know in the corner.</small>
        </span>
        <input
          className="setting-toggle"
          type="checkbox"
          role="switch"
          aria-labelledby="update-check-launch-label"
          checked={preferences.checkOnLaunch}
          onChange={(event) =>
            onPreferencesChange({ ...preferences, checkOnLaunch: event.target.checked })
          }
        />
      </label>

      <label className="setting-row">
        <span className="setting-copy">
          <strong id="update-prerelease-label">Include pre-releases</strong>
          <small>Also offer beta or preview builds published on GitHub before stable releases.</small>
        </span>
        <input
          className="setting-toggle"
          type="checkbox"
          role="switch"
          aria-labelledby="update-prerelease-label"
          checked={preferences.includePrereleases}
          onChange={(event) =>
            onPreferencesChange({ ...preferences, includePrereleases: event.target.checked })
          }
        />
      </label>
    </section>
  );
}
