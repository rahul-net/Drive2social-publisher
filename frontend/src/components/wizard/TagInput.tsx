// TagInput — comma/Enter separated tag editor with chips.

import { useState } from "react";

interface TagInputProps {
  id: string;
  label: string;
  tags: string[];
  onChange: (tags: string[]) => void;
  /** Extra validation before a tag is accepted; returns an error or null. */
  validateTag?: (tag: string, current: string[]) => string | null;
  placeholder?: string;
  disabled?: boolean;
}

export function TagInput({
  id,
  label,
  tags,
  onChange,
  validateTag,
  placeholder,
  disabled,
}: TagInputProps) {
  const [draft, setDraft] = useState("");
  const [tagError, setTagError] = useState<string | null>(null);

  const commitDraft = () => {
    const tag = draft.trim().replace(/^#+/, "").replace(/\s+/g, " ");
    setDraft("");
    if (!tag) return;
    if (tags.some((t) => t.toLowerCase() === tag.toLowerCase())) {
      setTagError(`“${tag}” is already added.`);
      return;
    }
    const problem = validateTag ? validateTag(tag, tags) : null;
    if (problem) {
      setTagError(problem);
      return;
    }
    setTagError(null);
    onChange([...tags, tag]);
  };

  return (
    <div className="form-field">
      <label htmlFor={id}>{label}</label>
      <div className="tag-chips" aria-live="polite">
        {tags.map((t) => (
          <span key={t} className="tag-chip">
            {t}
            <button
              type="button"
              className="tag-chip-remove"
              aria-label={`Remove tag ${t}`}
              disabled={disabled}
              onClick={() => onChange(tags.filter((x) => x !== t))}
            >
              ×
            </button>
          </span>
        ))}
        <input
          id={id}
          type="text"
          className="tag-input"
          value={draft}
          placeholder={tags.length === 0 ? placeholder : undefined}
          disabled={disabled}
          onChange={(e) => {
            setTagError(null);
            setDraft(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              commitDraft();
            } else if (
              e.key === "Backspace" &&
              draft === "" &&
              tags.length > 0
            ) {
              onChange(tags.slice(0, -1));
            }
          }}
          onBlur={commitDraft}
        />
      </div>
      {tagError && <div className="field-error">{tagError}</div>}
    </div>
  );
}
