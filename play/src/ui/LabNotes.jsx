// LabNotes: the evidence drawer. Everything that makes a claim checkable:
// Draft provenance and hashes, feasibility, each skill's policy manifest
// and eval summary, the look (cosmetic only), and raw JSON to copy.
// Render inside <Modal placement="right"> (a drawer) or inline.
import { CopyButton } from "./primitives.jsx";
import { DASH, duration, grouped, isNum, shortHash, skillName } from "./format.js";

function Rows({ rows }) {
  const list = rows.filter(r => r && r.value !== undefined && r.value !== null && r.value !== "");
  if (!list.length) return <p className="cl-hint">Nothing recorded yet.</p>;
  return (
    <dl className="cl-notes__rows">
      {list.map(row => (
        <div key={row.label}>
          <dt>{row.label}</dt>
          <dd>
            <span className={row.mono ? "cl-mono" : undefined}>{row.display ?? String(row.value)}</span>
            {row.copy ? <CopyButton text={String(row.value)} label={`Copy ${row.label.toLowerCase()}`} /> : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * LabNotes props:
 *  body (creature-body/1), look (creature-look/1)
 *  policies: { walk?: { manifest, eval, state }, jump?: {...} }   (creature-policy/1)
 *  extra: [{ title, rows: [{ label, value, display?, mono?, copy? }] }]
 *  json: object to show as raw evidence (defaults to body + policies + look)
 */
export function LabNotes({ body, look, policies = {}, extra = [], json }) {
  const prov = body?.provenance || {};
  const feas = body?.feasibility || {};
  const assets = prov.assetSha256 && typeof prov.assetSha256 === "object" ? Object.entries(prov.assetSha256) : [];
  const raw = JSON.stringify(json ?? { body: body ? { id: body.id, provenance: prov, feasibility: feas, massKg: body.massKg, dimensions: body.dimensions } : null, policies, look }, null, 2);
  return (
    <div className="cl-notes">
      <p className="cl-notes__honesty">
        Geometry, masses and motor sizes come from <strong>Draft</strong> (MIT; Nguyen, Coelho, Kim 2026) running on this computer. Physics runs in MuJoCo. Skills are PPO policies trained here and only unlocked after their checks pass for this exact body. Looks are paint: they never touch the physics.
      </p>

      <section className="cl-notes__group">
        <h3>Body from Draft</h3>
        <Rows
          rows={[
            { label: "Body id", value: body?.id, mono: true, copy: true },
            { label: "Generator", value: prov.generator },
            { label: "Template", value: prov.template },
            { label: "Draft revision", value: prov.draftRevision, display: shortHash(prov.draftRevision, 12), mono: true, copy: true },
            { label: "Feasibility", value: body ? (feas.passed ? "Passed" : "Failed") : undefined },
            { label: "Warnings", value: Array.isArray(feas.warnings) && feas.warnings.length ? feas.warnings.join(" ") : undefined },
            ...assets.map(([file, hash]) => ({ label: file, value: hash, display: shortHash(hash, 16), mono: true, copy: true })),
          ]}
        />
      </section>

      {Object.entries(policies).map(([skill, info]) => {
        const man = info?.manifest || {};
        const tr = man.training || {};
        const rows = info?.eval?.rows || [];
        return (
          <section className="cl-notes__group" key={skill}>
            <h3>{skillName(skill)} skill</h3>
            <Rows
              rows={[
                { label: "Status", value: info?.state || "untrained" },
                { label: "Checks", value: rows.length ? `${rows.filter(r => r.pass).length} of ${rows.length} passed` : undefined },
                { label: "Policy hash", value: man.policySha256, display: shortHash(man.policySha256, 16), mono: true, copy: true },
                { label: "Scene hash", value: man.sceneSha256, display: shortHash(man.sceneSha256, 16), mono: true, copy: true },
                { label: "Body hash match", value: info?.hashMatched === undefined ? undefined : info.hashMatched ? "Yes" : "No" },
                { label: "Algorithm", value: tr.algorithm },
                { label: "Practice steps", value: isNum(tr.envSteps) ? grouped(tr.envSteps) : undefined },
                { label: "Wall time", value: isNum(tr.wallSeconds) ? duration(tr.wallSeconds) : undefined },
                { label: "Machine", value: tr.machine },
                { label: "Seed", value: tr.seed },
                { label: "MuJoCo", value: tr.mujocoVersion },
              ]}
            />
            {(info?.honesty || man.honesty) && <p className="cl-hint">{info?.honesty || man.honesty}</p>}
          </section>
        );
      })}

      {look && (
        <section className="cl-notes__group">
          <h3>Look</h3>
          <Rows
            rows={[
              { label: "Theme", value: look.theme || DASH },
              { label: "Finish", value: look.finish },
              { label: "Physics", value: "Unchanged (cosmetic only)" },
            ]}
          />
        </section>
      )}

      {extra.map(group => (
        <section className="cl-notes__group" key={group.title}>
          <h3>{group.title}</h3>
          <Rows rows={group.rows || []} />
        </section>
      ))}

      <section className="cl-notes__group">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <h3>Raw evidence</h3>
          <CopyButton text={raw} label="Copy raw evidence" />
        </div>
        <textarea className="cl-notes__json" readOnly spellCheck={false} value={raw} aria-label="Raw evidence as JSON" rows={10} />
      </section>
    </div>
  );
}

export default LabNotes;
