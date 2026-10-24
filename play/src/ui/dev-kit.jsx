// Harness page: identity + primitives sheet.
import { Logo, LogoGlyph } from "./Logo.jsx";
import { Tinker } from "./Tinker.jsx";
import { Button, IconButton, Badge, Chip, Segmented, Slider, Switch, ProgressRing, Callout, Swatch, Keycap } from "./primitives.jsx";
import { ICON_NAMES, Icon } from "./icons.jsx";
import { CreatureGlyph } from "./CreatureGlyph.jsx";
import * as M from "./dev-mocks.js";

export function Kit() {
  return (
    <main className="cl-root cl-kit">
      <h1 className="cl-sr-only">Creature Lab UI kit: identity and primitives</h1>
      <section className="cl-kit__row">
        <Logo size="lg" />
        <Logo size="md" />
        <Logo size="sm" />
        <LogoGlyph size={32} />
        <LogoGlyph size={20} />
      </section>
      <section className="cl-kit__row cl-kit__row--end">
        {["idle", "thinking", "talking", "happy", "worried", "sleeping"].map(mood => (
          <figure key={mood} className="cl-kit__fig">
            <Tinker mood={mood} size={84} />
            <figcaption className="cl-hint">{mood}</figcaption>
          </figure>
        ))}
        <Tinker pose="full" wave mood="happy" size={150} />
        <Tinker pose="full" mood="thinking" size={110} />
        <Tinker mood="idle" size={28} />
      </section>
      <section className="cl-kit__row">
        <Button variant="primary" size="lg" icon="sparkle">Start creating</Button>
        <Button variant="primary" icon="blueprint">Build with Draft</Button>
        <Button>Pick a starter</Button>
        <Button variant="go" icon="play">Play</Button>
        <Button variant="blueprint" icon="hash">Lab notes</Button>
        <Button variant="danger" icon="stop" size="sm">Stop training</Button>
        <Button variant="ghost">Not now</Button>
        <Button disabled>Unplugged</Button>
        <Button busy variant="primary">Drafting</Button>
        <IconButton icon="settings" label="Settings" />
        <IconButton icon="sound" label="Sound" pressed />
        <IconButton icon="pause" label="Pause" round size="lg" variant="ink" />
        <Keycap>Space</Keycap>
        <Keycap>W</Keycap>
      </section>
      <section className="cl-kit__row">
        <Chip icon="sparkle">A frog that hops onto platforms</Chip>
        <Chip>Six legs, like a flower</Chip>
        <Chip pressed>Make it a ladybug</Chip>
        <Badge tone="good" icon="check">Walk ready</Badge>
        <Badge tone="warn" icon="alert">Untrained</Badge>
        <Badge tone="bad" icon="close">Failed</Badge>
        <Badge tone="info" icon="laptop">On this computer</Badge>
        <Badge tone="grape" icon="cloud">Cloud</Badge>
        <Badge tone="outline" icon="offline">Offline designer</Badge>
        <ProgressRing value={0.62} label="Training 62%">62</ProgressRing>
        <ProgressRing label="Loading" />
      </section>
      <section className="cl-kit__grid">
        <Segmented label="Finish" value="satin" onChange={() => {}} options={[{ value: "matte", label: "Matte" }, { value: "satin", label: "Satin" }, { value: "gloss", label: "Gloss" }, { value: "metal", label: "Metal" }]} />
        <Slider label="Torso length" value={0.46} min={0.25} max={0.8} step={0.01} format={v => `${v.toFixed(2)} m`} ends={["Short", "Long"]} />
        <Switch label="Sound effects" checked onChange={() => {}} />
        <Callout tone="warn" title="Untrained">Teach it to walk, about 12 min on your computer.</Callout>
        <div className="cl-kit__row">
          {["#2bae68", "#ffc63a", "#ec4d37", "#1e4e95", "#ff6f95"].map((c, i) => <Swatch key={c} color={c} label={c} selected={i === 0} />)}
        </div>
      </section>
      <section className="cl-kit__row">
        {[["cheetah", "#1f8c80"], ["bear", "#c47f3d"], ["giraffe", "#e2b43f"], ["flower", M.lookById("candy")], [M.DESIGN_HOPPER, M.lookById("frog")], [M.DESIGN_HOPPER, M.lookById("ladybug")], [M.DESIGN_HOPPER, M.lookById("jade")], [M.DESIGN_HOPPER, M.lookById("bee")], [M.DESIGN_SIDESTEP, M.lookById("tank")], [M.DESIGN_PETAL, M.lookById("midnight")]].map(([d, l], i) => (
          <span key={i} className="cl-kit__glyph">
            <CreatureGlyph design={d} look={l} />
          </span>
        ))}
        {[["cheetah"], [M.DESIGN_HOPPER], [M.DESIGN_PETAL], [M.DESIGN_SIDESTEP]].map(([d], i) => (
          <span key={`bp${i}`} className="cl-kit__glyph cl-kit__glyph--bp">
            <CreatureGlyph design={d} mode="blueprint" dims />
          </span>
        ))}
      </section>
      <section className="cl-kit__icons">
        {ICON_NAMES.map(name => (
          <span key={name} title={name}>
            <Icon name={name} size={26} />
            {name}
          </span>
        ))}
      </section>
    </main>
  );
}

export default Kit;
