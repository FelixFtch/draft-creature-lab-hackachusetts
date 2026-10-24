// TitleScreen: the first-run moment. A creature is drawn as a blueprint,
// then fills in as a toy, while the wordmark's lettering slides from
// technical to toy (Recursive's casual axis). Tinker says hello; one big
// "Start creating" plus starter creatures to jump straight in.
import { useEffect, useId, useRef } from "react";
import { CreatureGlyph } from "./CreatureGlyph.jsx";
import { Tinker } from "./Tinker.jsx";
import { Logo } from "./Logo.jsx";
import { Icon } from "./icons.jsx";
import { Button, cx } from "./primitives.jsx";

const STARTER_BLURB = {
  cheetah: "Light and quick",
  bear: "Sturdy and stocky",
  giraffe: "Long, lovely legs",
  flower: "Six legs all around",
};

/**
 * TitleScreen props:
 *  onStart(): begin with Tinker; onStarter(id): open a starter
 *  starters: [{ id, name, design, look, blurb?, skills? }]
 *  hero: { design, look } for the big drawing (default: a cheetah in workshop teal)
 *  continueWith: { name, onClick } when the player already has a creature
 *  greeting: Tinker's line
 */
export function TitleScreen({ onStart, onStarter, starters = [], hero, continueWith, greeting = "Hi, I'm Tinker! Describe a creature and I'll draft a real robot body for it. Then we teach it to move." }) {
  const titleId = useId();
  const start = useRef(null);
  useEffect(() => {
    start.current?.focus({ preventScroll: true });
  }, []);
  const heroDesign = hero?.design || "cheetah";
  const heroLook = hero?.look || "#1f8c80";
  return (
    <section className="cl-title" aria-labelledby={titleId}>
      <div className="cl-title__sheet" aria-hidden="true">
        <span className="cl-title__corner cl-title__corner--tl" />
        <span className="cl-title__corner cl-title__corner--br" />
      </div>
      <div className="cl-title__hero" aria-hidden="true">
        <div className="cl-title__drawing">
          <CreatureGlyph design={heroDesign} mode="blueprint" dims className="cl-title__lines" />
          <CreatureGlyph design={heroDesign} look={heroLook} exact className="cl-title__toy" />
        </div>
        <p className="cl-title__annot cl-tech">
          <span>fig. 1</span> a creature, drafted
        </p>
      </div>
      <div className="cl-title__panel">
        <h1 id={titleId} className="cl-title__logo">
          <Logo size="lg" as="span" />
        </h1>
        <p className="cl-title__lede">Tell Tinker an idea. Get a real robot body. Teach it to move, then play.</p>
        <div className="cl-title__tinker">
          <Tinker pose="full" mood="happy" wave size={118} />
          <p className="cl-title__bubble">{greeting}</p>
        </div>
        <div className="cl-title__actions">
          <Button ref={start} variant="primary" size="lg" icon="sparkle" onClick={onStart}>
            Start creating
          </Button>
          {continueWith && (
            <Button size="lg" icon="play" onClick={continueWith.onClick}>
              Continue with {continueWith.name}
            </Button>
          )}
        </div>
        {starters.length > 0 && (
          <div className="cl-title__starters">
            <h2 className="cl-title__h2">Or pick a starter</h2>
            <ul>
              {starters.map(s => (
                <li key={s.id}>
                  <button type="button" className="cl-starter" onClick={() => onStarter?.(s.id)}>
                    <span className="cl-starter__art">
                      <CreatureGlyph design={s.design} look={s.look} />
                    </span>
                    <span className="cl-starter__name">{s.name}</span>
                    <span className="cl-starter__blurb">{s.blurb || STARTER_BLURB[s.design] || ""}</span>
                    {s.skills?.walk === "ready" && (
                      <span className="cl-starter__walks">
                        <Icon name="walk" size={13} strokeWidth={2.5} /> Walks
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        <p className={cx("cl-title__small")}>Runs on your computer. Bodies by Draft (MIT), physics by MuJoCo, skills learned right here.</p>
      </div>
    </section>
  );
}

export default TitleScreen;
