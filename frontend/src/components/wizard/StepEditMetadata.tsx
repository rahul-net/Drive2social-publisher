// Wizard step 4 — Edit metadata.
//
// Fully editable form for the Gemini suggestion (or manually written
// fields). Character counts enforce platform limits; the provenance
// badge says honestly how the metadata was produced.
//
// Phase 8: the user's description template (Settings page) prefills
// an empty YouTube description once (with {title}/{filename}
// substitution), and their default hashtags are offered as one-click
// "add" chips under the hashtag editor.

import { useEffect, useRef, useState } from "react";
import { useCreatePost } from "../../contexts/CreatePostContext";
import { useAuth } from "../../contexts/AuthContext";
import { useToast } from "../../contexts/ToastContext";
import {
  applyDescriptionTemplate,
  loadUserSettings,
} from "../../lib/settings";
import { ErrorState } from "../States";
import { TagInput } from "./TagInput";

const TITLE_LIMIT = 100;
const DESCRIPTION_LIMIT = 5000;
const TAGS_TOTAL_LIMIT = 500;
const HASHTAG_LIMIT = 10;
const CAPTION_SOFT_LIMIT = 300;

export function StepEditMetadata({
  onNext,
  onBack,
}: {
  onNext: () => void;
  onBack: () => void;
}) {
  const { file, metadata, setMetadata, provenance } = useCreatePost();
  const { user } = useAuth();
  const { notify } = useToast();
  // Phase 8: template + default hashtags from the Settings page.
  const [userDefaults, setUserDefaults] = useState<{
    template: string;
    hashtags: string[];
  } | null>(null);
  // The template is applied at most once, and only while the
  // description is still empty, so user edits are never clobbered.
  const templateAppliedRef = useRef(false);

  useEffect(() => {
    if (!user || userDefaults) return;
    let cancelled = false;
    loadUserSettings()
      .then((s) => {
        if (cancelled || !s) return;
        setUserDefaults({
          template: s.defaultDescriptionTemplate,
          hashtags: s.defaultHashtags,
        });
      })
      .catch(() => {
        // Non-fatal: no template, no chips.
      });
    return () => {
      cancelled = true;
    };
  }, [user, userDefaults]);

  useEffect(() => {
    if (!userDefaults || !metadata || templateAppliedRef.current) return;
    if (userDefaults.template.trim() === "") return;
    if (metadata.youtube_description.trim() !== "") return;
    templateAppliedRef.current = true;
    setMetadata({
      ...metadata,
      youtube_description: applyDescriptionTemplate(userDefaults.template, {
        title: metadata.youtube_title,
        filename: file?.name ?? "",
      }),
    });
    notify("info", "Description prefilled from your template.");
  }, [userDefaults, metadata, file, setMetadata, notify]);

  if (!metadata) {
    return (
      <ErrorState
        title="No metadata yet"
        hint="Generate metadata with Gemini in step 3, or write it manually."
      />
    );
  }

  const tagsTotalChars = metadata.youtube_tags.join("").length;

  const badge =
    provenance?.source === "generated" ? (
      provenance.analysisMode === "frames" ? (
        <span className="badge badge-ok">
          ✨ Generated from {provenance.framesUsed} video frames
        </span>
      ) : (
        <span className="badge badge-warn" title="ffmpeg is not available on this server, so no video frames were extracted.">
          Generated from file info only (ffmpeg unavailable)
        </span>
      )
    ) : (
      <span className="badge">Written manually</span>
    );

  return (
    <div>
      <div className="badge-row">{badge}</div>

      <div className="form-field">
        <label htmlFor="meta-title">YouTube title</label>
        <input
          id="meta-title"
          type="text"
          className="form-input"
          value={metadata.youtube_title}
          maxLength={TITLE_LIMIT}
          placeholder="A clear, specific title"
          onChange={(e) =>
            setMetadata({ ...metadata, youtube_title: e.target.value })
          }
        />
        <div className="char-count">
          {metadata.youtube_title.length}/{TITLE_LIMIT}
        </div>
      </div>

      <div className="form-field">
        <label htmlFor="meta-description">YouTube description</label>
        <textarea
          id="meta-description"
          className="form-textarea"
          rows={6}
          value={metadata.youtube_description}
          maxLength={DESCRIPTION_LIMIT}
          placeholder="What should viewers know about this video?"
          onChange={(e) =>
            setMetadata({ ...metadata, youtube_description: e.target.value })
          }
        />
        <div className="char-count">
          {metadata.youtube_description.length}/{DESCRIPTION_LIMIT}
        </div>
      </div>

      <TagInput
        id="meta-tags"
        label="YouTube tags"
        tags={metadata.youtube_tags}
        placeholder="Add tags with Enter or comma…"
        onChange={(youtube_tags) => setMetadata({ ...metadata, youtube_tags })}
        validateTag={(tag, current) => {
          const total = current.join("").length + tag.length;
          return total > TAGS_TOTAL_LIMIT
            ? `Adding “${tag}” would exceed the 500-character tag limit.`
            : null;
        }}
      />
      <div className="char-count tag-total-count">
        {tagsTotalChars}/{TAGS_TOTAL_LIMIT} characters total
      </div>

      <div className="form-field">
        <label htmlFor="meta-caption">Facebook caption</label>
        <textarea
          id="meta-caption"
          className="form-textarea"
          rows={3}
          value={metadata.facebook_caption}
          placeholder="A short, friendly caption for the Facebook post"
          onChange={(e) =>
            setMetadata({ ...metadata, facebook_caption: e.target.value })
          }
        />
        <div className="char-count">
          {metadata.facebook_caption.length} characters
          {metadata.facebook_caption.length > CAPTION_SOFT_LIMIT &&
            " — long for a Facebook caption, consider trimming"}
        </div>
      </div>

      <TagInput
        id="meta-hashtags"
        label="Hashtags"
        tags={metadata.hashtags}
        placeholder="Add hashtags with Enter or comma…"
        onChange={(hashtags) => setMetadata({ ...metadata, hashtags })}
        validateTag={(_, current) =>
          current.length >= HASHTAG_LIMIT
            ? `At most ${HASHTAG_LIMIT} hashtags.`
            : null
        }
      />
      {/* Phase 8: default hashtags from the Settings page as one-click chips. */}
      {userDefaults && userDefaults.hashtags.length > 0 && (
        <div className="form-field">
          <div className="muted field-hint">From your defaults:</div>
          <div className="chip-row">
            {userDefaults.hashtags
              .filter(
                (h) =>
                  !metadata.hashtags.some(
                    (t) => t.toLowerCase() === h.toLowerCase(),
                  ),
              )
              .map((h) => (
                <button
                  key={h}
                  type="button"
                  className="chip"
                  title={`Add #${h}`}
                  style={{ cursor: "pointer" }}
                  onClick={() =>
                    setMetadata({
                      ...metadata,
                      hashtags: [...metadata.hashtags, h],
                    })
                  }
                >
                  + #{h}
                </button>
              ))}
          </div>
        </div>
      )}

      <div className="notice notice-info" role="note">
        <strong>Next:</strong> choose your YouTube channel and Facebook
        Page, review the settings, and publish. Your metadata is saved
        and carries over.
      </div>

      <div className="wizard-nav">
        <button
          type="button"
          className="btn"
          onClick={() => {
            notify("info", "Back to generation — your edits are saved.");
            onBack();
          }}
        >
          ← Regenerate
        </button>
        <button type="button" className="btn btn-primary" onClick={onNext}>
          Continue
        </button>
      </div>
    </div>
  );
}
