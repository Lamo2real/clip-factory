// TikTok's "Who can see it" (TikTok's Content Sharing Guidelines, CONTRACTS §17.8 and §36): the app's own dropdown
// (never the OS list) with exactly the choices TikTok offers this creator, Everyone first, and nothing picked until
// the owner picks one or taps Use my settings. While the owner's Mac posts TikTok (§47.9) the Review card's row lists
// TikTok Studio's choices (Everyone, Friends, Only me) and starts on My settings; the Mac posts what is picked. Used in
// the TikTok row on the Review card and on the TikTok sheet.
import { useId } from "react";
import type { TikTokCreator } from "../../api/types.ts";
import { Dropdown } from "../../components/Dropdown.tsx";
import { Icon } from "../../components/Icon.tsx";
import { BRANDED_PRIVATE_LINE, onlyPrivateAllowed, orderedPrivacy, PRIVACY_LABEL, privacyChoices } from "../../lib/tiktokChoices.ts";

export function TikTokPrivacy({
  creator,
  value,
  branded,
  onChange,
}: {
  creator: TikTokCreator;
  value: string;
  /** Branded content is on: Only me and Followers show greyed with TikTok's line (TikTok's rule). */
  branded: boolean;
  onChange: (privacy: string) => void;
}) {
  const id = useId();
  const allowed = privacyChoices(creator.privacyOptions, branded);
  const onlyMe = onlyPrivateAllowed(creator.privacyOptions);
  return (
    <div className="field">
      <span className="field__label" id={`${id}-label`}>
        Who can see it
      </span>
      {allowed.length ? (
        <Dropdown
          labelledBy={`${id}-label`}
          value={value}
          placeholder="Pick who can see it"
          options={orderedPrivacy(creator.privacyOptions).map((o) => {
            const off = !allowed.includes(o);
            return { value: o, label: PRIVACY_LABEL[o] ?? o, disabled: off, line: off ? BRANDED_PRIVATE_LINE : undefined };
          })}
          onChange={onChange}
          describedBy={onlyMe ? `${id}-hint` : undefined}
        />
      ) : (
        <p className="callout callout--bad" role="alert">
          <Icon name="alert" size={18} />
          <span>Branded content can&apos;t be Only me. Turn off Branded content.</span>
        </p>
      )}
      {onlyMe ? (
        <p className="field__hint" id={`${id}-hint`}>
          TikTok keeps posts private until it approves Clip Factory.
        </p>
      ) : null}
    </div>
  );
}
