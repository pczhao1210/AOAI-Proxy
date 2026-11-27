import { computeConfigDiff, buildConfigDiffPreview } from "../utils.js";

export default function ReviewChanges({ before, after, t }) {
  const groups = [["upstreams", "channels", "name"], ["models", "models", "id"], ["apiKeys", "keys", "id"]];
  const settingsBefore = { ...before };
  const settingsAfter = { ...after };
  const reviews = groups.map(([collection, label, identity]) => {
    delete settingsBefore[collection]; delete settingsAfter[collection];
    const ids = [...new Set([...(before[collection] || []), ...(after[collection] || [])].map(item => item[identity]))];
    return {
      label,
      entities: ids.map(id => ({
        id,
        diff: computeConfigDiff(before[collection]?.find(item => item[identity] === id), after[collection]?.find(item => item[identity] === id))
      }))
    };
  });
  reviews.push({ label: "settings", entities: [{ id: "", diff: computeConfigDiff(settingsBefore, settingsAfter) }] });
  return <div className="review-groups">
    {reviews.map(({ label, entities }) => {
      const changed = entities.filter(({ diff }) => Object.values(diff).some(paths => paths.length));
      if (!changed.length) return null;
      return <section key={label}>
        <h3>{t(`shell.page.${label}`)}</h3>
        {changed.map(({ id, diff }) => <details key={id} open>
          <summary>{id || t("shell.page.settings")}</summary>
          <pre>{buildConfigDiffPreview(diff, t, Infinity)}</pre>
        </details>)}
      </section>;
    })}
  </div>;
}
