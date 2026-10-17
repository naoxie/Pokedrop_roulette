"use strict";

(() => {
  // 1. CONFIGURATION — modifier ici la probabilité et la durée (millisecondes).
  // Les surfaces graphiques sont égales, mais ne déterminent pas le tirage.
  const CONFIG = {
    winProbability: 0.35,
    spinDuration: 6500,
    minRotations: 5,
    maxRotations: 8
  };

  const FULL_TURN = 360;
  const SEGMENT_ANGLE = 90;
  const EDGE_MARGIN = 18; // Au moins 18° de chaque séparation.
  // Angles horaires depuis 12 h : haut droite, bas droite, bas gauche, haut gauche.
  const SEGMENTS = Object.freeze(["lose", "win", "lose", "win"]);
  const randomBuffer = new Uint32Array(1);

  function validateConfig(config) {
    if (!Number.isFinite(config.winProbability) || config.winProbability < 0 || config.winProbability > 1) {
      throw new RangeError("winProbability doit être un nombre compris entre 0 et 1.");
    }
    if (!Number.isFinite(config.spinDuration) || config.spinDuration < 0) {
      throw new RangeError("spinDuration doit être un nombre positif ou nul.");
    }
    if (!Number.isSafeInteger(config.minRotations) || !Number.isSafeInteger(config.maxRotations) ||
        config.minRotations < 1 || config.maxRotations < config.minRotations || config.maxRotations > 100) {
      throw new RangeError("Les rotations doivent être des entiers entre 1 et 100, avec minRotations ≤ maxRotations.");
    }
  }

  // 2. TIRAGE — aucun accès au DOM et aucune dépendance à l'animation.
  function randomUnit() {
    if (globalThis.crypto && typeof globalThis.crypto.getRandomValues === "function") {
      globalThis.crypto.getRandomValues(randomBuffer);
      return randomBuffer[0] / 4294967296; // Valeur dans [0, 1[, jamais 1.
    }
    return Math.random();
  }

  function drawOutcome(probability = CONFIG.winProbability, random = randomUnit) {
    const won = random() < probability;
    const matchingSegments = won ? [1, 3] : [0, 2];
    return { won, segmentIndex: matchingSegments[Math.floor(random() * 2)] };
  }

  // 3. ANGLES — le résultat est fixé avant le premier mouvement du disque.
  function normalizeAngle(angle) {
    return ((angle % FULL_TURN) + FULL_TURN) % FULL_TURN;
  }

  function getSegmentAtAngle(rotation) {
    return Math.floor(normalizeAngle(-rotation) / SEGMENT_ANGLE);
  }

  function createSpinPlan(currentAngle, config = CONFIG, random = randomUnit) {
    validateConfig(config);
    const outcome = drawOutcome(config.winProbability, random);
    const landingAngle = outcome.segmentIndex * SEGMENT_ANGLE + EDGE_MARGIN +
      random() * (SEGMENT_ANGLE - EDGE_MARGIN * 2);
    const rotations = config.minRotations + Math.floor(random() * (config.maxRotations - config.minRotations + 1));
    // À l'arrivée, angle local + rotation = 0° (la flèche est à 12 h).
    const alignment = normalizeAngle(-landingAngle - normalizeAngle(currentAngle));
    const targetAngle = currentAngle + rotations * FULL_TURN + alignment;
    return { ...outcome, rotations, landingAngle, targetAngle };
  }

  // Accélération sur 8 % de la durée, puis décélération progressive.
  // L'intégrale de la vitesse donne une position continue de 0 à 1.
  function spinEasing(progress) {
    const acceleration = 0.08;
    const totalArea = acceleration / 2 + (1 - acceleration) / 4;
    if (progress < acceleration) {
      return progress * progress / (2 * acceleration * totalArea);
    }
    const coast = (progress - acceleration) / (1 - acceleration);
    return (acceleration / 2 + (1 - acceleration) * (1 - Math.pow(1 - coast, 4)) / 4) / totalArea;
  }

  // 4. TEST STATISTIQUE — exécuter PokeDrop.runStatisticalTest() dans la console.
  // Ne lance pas d'animation et ne modifie jamais la partie en cours.
  function runStatisticalTest(draws = 100000, probability = CONFIG.winProbability) {
    if (!Number.isSafeInteger(draws) || draws < 1 || draws > 10000000) {
      throw new RangeError("Le nombre de tirages doit être compris entre 1 et 10 000 000.");
    }
    validateConfig({ ...CONFIG, winProbability: probability });
    let wins = 0;
    const segmentCounts = [0, 0, 0, 0];
    for (let index = 0; index < draws; index += 1) {
      const outcome = drawOutcome(probability);
      if (outcome.won) wins += 1;
      segmentCounts[outcome.segmentIndex] += 1;
    }
    const frequency = wins / draws;
    // Une tolérance de cinq écarts-types évite un test aléatoire trop fragile.
    const tolerance = 5 * Math.sqrt(probability * (1 - probability) / draws);
    const report = {
      draws, wins, losses: draws - wins, expectedProbability: probability,
      frequency, difference: frequency - probability, tolerance,
      passed: Math.abs(frequency - probability) <= tolerance,
      segmentCounts
    };
    console.table(report);
    return report;
  }

  // API de diagnostic sans dépendances, aussi utilisable dans Node pour les tests.
  const diagnostics = Object.freeze({ CONFIG, SEGMENTS, randomUnit, drawOutcome, normalizeAngle, getSegmentAtAngle, createSpinPlan, spinEasing, runStatisticalTest });
  if (typeof module !== "undefined" && module.exports) module.exports = diagnostics;
  if (typeof window !== "undefined") window.PokeDrop = diagnostics;
  if (typeof document === "undefined") return;

  // 5. INITIALISATION — la logique visuelle reste séparée du tirage.
  const wheel = document.getElementById("wheel");
  const disc = document.getElementById("wheel-disc");
  const spinButton = document.getElementById("spin-button");
  const spinStatus = document.getElementById("spin-status");
  const dialog = document.getElementById("result-modal");
  const closeButton = document.getElementById("close-result");
  const effects = document.getElementById("result-effects");
  const rewardSlot = document.getElementById("result-reward");
  const rewardTemplate = document.getElementById("reward-template");
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let currentAngle = 0;
  let roundPhase = "loading";
  let roundController = null;
  let activePlan = null;
  let interruptedOutcome = null;
  let rewardImageAvailable = false;

  // Un verrou couvre toute la séquence, jusqu'à la fin du retour du fond.
  function setPhase(phase) {
    roundPhase = phase;
    document.body.dataset.phase = phase;
    const spinning = phase === "spinning";
    spinButton.disabled = phase !== "idle";
    spinButton.classList.toggle("is-spinning", spinning);
    wheel.classList.toggle("is-spinning", spinning);
    wheel.setAttribute("aria-busy", String(spinning || phase === "celebrating"));
  }

  function darkenBackground() {
    document.body.classList.add("is-focused");
  }

  function restoreBackground(signal) {
    document.body.classList.remove("is-focused");
    return waitForDuration(reducedMotion.matches ? 120 : 800, signal);
  }

  // Les délais se mettent en pause hors écran et se libèrent à l'annulation.
  // Aucun ancien minuteur ne peut ouvrir un résultat pendant une nouvelle partie.
  function waitForDuration(duration, signal) {
    return new Promise((resolve, reject) => {
      let remaining = duration;
      let startedAt = 0;
      let timer = null;
      function cleanup() {
        clearTimeout(timer);
        document.removeEventListener("visibilitychange", onVisibility);
        signal?.removeEventListener("abort", onAbort);
      }
      function finish() { cleanup(); resolve(); }
      function onAbort() { cleanup(); reject(new DOMException("Animation interrompue", "AbortError")); }
      function resume() {
        if (document.hidden) return;
        startedAt = performance.now();
        timer = setTimeout(finish, Math.max(0, remaining));
      }
      function onVisibility() {
        if (document.hidden) {
          if (timer !== null) remaining -= performance.now() - startedAt;
          clearTimeout(timer);
          timer = null;
        } else if (timer === null) resume();
      }
      if (signal?.aborted) { onAbort(); return; }
      signal?.addEventListener("abort", onAbort, { once: true });
      document.addEventListener("visibilitychange", onVisibility);
      resume();
    });
  }

  // 6. ANIMATION — mêmes durée, courbe et angle final ; seule la roue tourne.
  function animateSpin(plan, signal) {
    const startAngle = currentAngle;
    const angleDistance = plan.targetAngle - startAngle;
    const duration = reducedMotion.matches ? Math.min(CONFIG.spinDuration, 180) : CONFIG.spinDuration;
    return new Promise((resolve, reject) => {
      let frameId = null;
      let previousTime;
      let elapsed = 0;
      let paintFrames = 0;
      function cleanup() {
        cancelAnimationFrame(frameId);
        document.removeEventListener("visibilitychange", onVisibility);
        signal.removeEventListener("abort", onAbort);
      }
      function onAbort() { cleanup(); reject(new DOMException("Rotation interrompue", "AbortError")); }
      function onVisibility() {
        cancelAnimationFrame(frameId);
        previousTime = undefined;
        if (!document.hidden) frameId = requestAnimationFrame(frame);
      }
      function frame(timestamp) {
        if (paintFrames > 0) {
          paintFrames -= 1;
          if (paintFrames === 0) { cleanup(); resolve(); return; }
          frameId = requestAnimationFrame(frame);
          return;
        }
        if (previousTime !== undefined) elapsed += timestamp - previousTime;
        previousTime = timestamp;
        const progress = duration === 0 ? 1 : Math.min(elapsed / duration, 1);
        // En mode mouvement réduit, pas de rotation visible rapide : arrivée directe.
        if (!reducedMotion.matches || progress === 1) {
          currentAngle = progress === 1 ? plan.targetAngle : startAngle + angleDistance * spinEasing(progress);
          disc.style.transform = `rotate(${currentAngle}deg)`;
        }
        // Deux images à l'arrêt avant de démarrer les effets du résultat.
        if (progress === 1) paintFrames = 2;
        frameId = requestAnimationFrame(frame);
      }
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener("abort", onAbort, { once: true });
      document.addEventListener("visibilitychange", onVisibility);
      if (!document.hidden) frameId = requestAnimationFrame(frame);
    });
  }

  // 7. EFFETS — un calque borné, au maximum 38 particules, puis nettoyage.
  function updateEffectOrigin() {
    if (effects.hidden) return;
    const bounds = wheel.getBoundingClientRect();
    effects.style.setProperty("--origin-x", `${bounds.left + bounds.width / 2}px`);
    effects.style.setProperty("--origin-y", `${bounds.top + bounds.height / 2}px`);
    effects.style.setProperty("--wheel-size", `${bounds.width * 0.9}px`);
  }

  function cleanupEffects() {
    effects.replaceChildren();
    effects.hidden = true;
    wheel.classList.remove("result-win", "result-lose");
  }

  function prepareEffects(type) {
    cleanupEffects();
    effects.hidden = false;
    updateEffectOrigin();
    wheel.classList.add(`result-${type}`);
  }

  function addTemporaryEffect(element) {
    element.addEventListener("animationend", () => element.remove(), { once: true });
    effects.append(element);
    return element;
  }

  function createLightPulse(color, soft = false) {
    if (reducedMotion.matches) return;
    const pulse = document.createElement("div");
    pulse.className = `light-pulse${soft ? " light-pulse--soft" : ""}`;
    pulse.style.setProperty("--effect-color", color);
    addTemporaryEffect(pulse);
  }

  function createParticles(type, count) {
    if (reducedMotion.matches) return;
    const winning = type === "win";
    const radius = wheel.getBoundingClientRect().width / 2;
    const colors = winning ? ["#FFD700", "#FFF3A0", "#E000FF", "#8500FF"] : ["#b88aff", "#8500FF", "#d786ed"];
    const kinds = winning ? ["star", "spark", "confetti", "trail"] : ["spark", "star"];
    const fragment = document.createDocumentFragment();
    const limit = Math.min(count, winning ? 38 : 12);
    for (let index = 0; index < limit; index += 1) {
      const angle = (index / limit * Math.PI * 2) + randomUnit() * 0.2;
      const startRadius = winning ? randomUnit() * radius * 0.45 : radius * 0.65;
      const distance = radius * (winning ? 0.65 + randomUnit() * 0.9 : 0.85 + randomUnit() * 0.3);
      const particle = document.createElement("i");
      particle.className = `result-particle result-particle--${kinds[index % kinds.length]}`;
      particle.style.setProperty("--start-x", `${Math.cos(angle) * startRadius}px`);
      particle.style.setProperty("--start-y", `${Math.sin(angle) * startRadius}px`);
      particle.style.setProperty("--end-x", `${Math.cos(angle) * distance}px`);
      particle.style.setProperty("--end-y", `${Math.sin(angle) * distance + (winning ? 30 : -20)}px`);
      particle.style.setProperty("--rotation", `${angle * 180 / Math.PI - 90}deg`);
      particle.style.setProperty("--end-rotation", `${angle * 180 / Math.PI + (winning ? 180 : -90)}deg`);
      particle.style.setProperty("--size", `${(winning ? 4 : 3) + randomUnit() * (winning ? 7 : 3)}px`);
      particle.style.setProperty("--duration", `${650 + randomUnit() * (winning ? 500 : 250)}ms`);
      particle.style.setProperty("--delay", `${randomUnit() * 100}ms`);
      particle.style.setProperty("--particle-color", colors[index % colors.length]);
      particle.addEventListener("animationend", () => particle.remove(), { once: true });
      fragment.append(particle);
    }
    effects.append(fragment);
  }

  function createRewardVisual() {
    const visual = rewardTemplate.content.firstElementChild.cloneNode(true);
    if (rewardImageAvailable) {
      const image = visual.querySelector(".reward-image");
      const fallback = visual.querySelector(".bonus-pack");
      image.addEventListener("error", () => { image.hidden = true; fallback.hidden = false; }, { once: true });
      image.src = "assets/img/booster_reward.png";
      image.hidden = false;
      fallback.hidden = true;
    }
    return visual;
  }

  async function playWinAnimation(signal) {
    if (reducedMotion.matches) { await waitForDuration(120, signal); return; }
    prepareEffects("win");
    createLightPulse("#FFD700");
    const flash = document.createElement("div");
    flash.className = "effect-flash";
    addTemporaryEffect(flash);
    await waitForDuration(400, signal);
    createParticles("win", 38);
    await waitForDuration(reducedMotion.matches ? 0 : 600, signal);
    const reveal = document.createElement("div");
    reveal.className = "reward-reveal";
    reveal.append(createRewardVisual());
    effects.append(reveal);
    await waitForDuration(reducedMotion.matches ? 120 : 1200, signal);
  }

  async function playLoseAnimation(signal) {
    if (reducedMotion.matches) { await waitForDuration(120, signal); return; }
    prepareEffects("lose");
    createLightPulse("#b88aff", true);
    await waitForDuration(200, signal);
    createParticles("lose", 12);
    await waitForDuration(reducedMotion.matches ? 120 : 1050, signal);
  }

  // 8. RÉSULTAT — le paquet de la révélation est réutilisé dans le dialogue.
  function showResult(won) {
    dialog.dataset.result = won ? "win" : "lose";
    document.getElementById("result-kicker").textContent = won ? "Votre fidélité récompensée" : "Merci d'avoir joué";
    document.getElementById("result-title").textContent = won ? "FÉLICITATIONS !" : "DOMMAGE !";
    document.getElementById("result-message").textContent = won
      ? "TU GAGNES UN BOOSTER SUPPLÉMENTAIRE !"
      : "Pas de booster supplémentaire cette fois-ci.";
    const thanks = document.getElementById("result-thanks");
    thanks.textContent = won ? "" : "Merci pour ta fidélité !";
    thanks.hidden = won;
    rewardSlot.replaceChildren();
    rewardSlot.hidden = !won;
    if (won) rewardSlot.append(effects.querySelector(".reward-visual") || createRewardVisual());
    cleanupEffects();
    spinStatus.textContent = won ? "Gagné ! Un booster supplémentaire pour vous." : "Perdu pour cette fois. Merci pour votre fidélité !";
    setPhase("result");
    dialog.showModal();
  }

  async function closeResult() {
    if (roundPhase !== "result") return;
    const controller = roundController;
    setPhase("restoring");
    if (dialog.open) dialog.close();
    cleanupEffects();
    rewardSlot.replaceChildren();
    rewardSlot.hidden = true;
    try {
      await restoreBackground(controller.signal);
      activePlan = null;
      setPhase("idle");
      spinButton.focus({ preventScroll: true });
    } catch (error) {
      if (error.name !== "AbortError") console.error("Fermeture du résultat :", error);
    }
  }

  // 9. INTERACTIONS — aucun nouveau lancer pendant les effets ou leur fermeture.
  async function handleSpin() {
    if (roundPhase !== "idle" || dialog.open || spinButton.disabled) return;
    roundController?.abort();
    roundController = new AbortController();
    const { signal } = roundController;
    setPhase("spinning");
    darkenBackground();
    spinStatus.textContent = "La roue tourne… Bonne chance !";
    try {
      const plan = createSpinPlan(currentAngle);
      activePlan = plan;
      await animateSpin(plan, signal);
      if (getSegmentAtAngle(currentAngle) !== plan.segmentIndex) {
        throw new Error("Le quartier affiché ne correspond pas au tirage.");
      }
      setPhase("celebrating");
      spinStatus.textContent = plan.won ? "Gagné ! Votre récompense arrive…" : "Merci pour votre fidélité !";
      if (plan.won) await playWinAnimation(signal);
      else await playLoseAnimation(signal);
      if (signal.aborted) return;
      showResult(plan.won);
    } catch (error) {
      if (error.name === "AbortError") return;
      console.error("Impossible de terminer le lancer :", error);
      cleanupEffects();
      setPhase("restoring");
      spinStatus.textContent = "Le lancer n'a pas pu aboutir. Veuillez réessayer.";
      try {
        await restoreBackground(signal);
        activePlan = null;
        setPhase("idle");
      } catch (interruption) {
        if (interruption.name !== "AbortError") console.error(interruption);
      }
    }
  }

  spinButton.addEventListener("click", handleSpin);
  closeButton.addEventListener("click", closeResult);
  dialog.addEventListener("cancel", (event) => { event.preventDefault(); closeResult(); });
  dialog.addEventListener("click", (event) => {
    const bounds = dialog.getBoundingClientRect();
    if (event.target === dialog && (event.clientX < bounds.left || event.clientX > bounds.right ||
        event.clientY < bounds.top || event.clientY > bounds.bottom)) closeResult();
  });
  dialog.addEventListener("close", closeResult);
  document.addEventListener("visibilitychange", () => {
    document.body.classList.toggle("is-paused", document.hidden);
  });
  window.addEventListener("resize", updateEffectOrigin);
  document.addEventListener("scroll", updateEffectOrigin, { passive: true });

  // En cas de navigation / cache de retour : annuler les callbacks et conserver
  // le résultat déjà tiré. Le retour à la page ne tire jamais une seconde fois.
  window.addEventListener("pagehide", () => {
    if (roundPhase === "idle" || roundPhase === "loading") return;
    interruptedOutcome = activePlan && roundPhase !== "restoring" ? activePlan.won : null;
    if (activePlan) {
      currentAngle = activePlan.targetAngle;
      disc.style.transform = `rotate(${currentAngle}deg)`;
    }
    setPhase("interrupted");
    roundController?.abort();
    if (dialog.open) dialog.close();
    cleanupEffects();
    rewardSlot.replaceChildren();
    rewardSlot.hidden = true;
    document.body.classList.remove("is-focused");
  });
  window.addEventListener("pageshow", () => {
    if (roundPhase !== "interrupted") return;
    document.body.classList.toggle("is-paused", document.hidden);
    roundController = new AbortController();
    if (interruptedOutcome !== null) {
      darkenBackground();
      showResult(interruptedOutcome);
      interruptedOutcome = null;
    } else {
      activePlan = null;
      setPhase("idle");
    }
  });

  // Ne pas démarrer une partie tant que les images essentielles sont absentes.
  async function initialize() {
    try {
      validateConfig(CONFIG);
      const essentialImages = [...document.querySelectorAll(".brand-logo, .wheel-center, .wheel-pointer img, .spin-button img")];
      await Promise.all(essentialImages.map((image) => {
        if (image.complete) return image.naturalWidth ? Promise.resolve() : Promise.reject(new Error(image.src));
        return new Promise((resolve, reject) => {
          image.addEventListener("load", resolve, { once: true });
          image.addEventListener("error", () => reject(new Error(image.src)), { once: true });
        });
      }));
      document.querySelector(".probability-note").textContent = `${(CONFIG.winProbability * 100).toLocaleString("fr-FR", { maximumFractionDigits: 2 })} % de chance de gagner à chaque lancer`;
      setPhase("idle");
      spinStatus.textContent = "À vous de jouer !";
    } catch (error) {
      console.error("Initialisation de PokeDrop :", error);
      spinStatus.textContent = "La roulette n'a pas pu se charger. Vérifiez les images et rechargez la page.";
    }
  }

  // Le chargement facultatif ne bloque jamais le jeu et garde le cadeau CSS
  // en cas d'absence, de réseau indisponible ou d'image invalide.
  const optionalBooster = new Image();
  optionalBooster.addEventListener("load", () => { rewardImageAvailable = optionalBooster.naturalWidth > 0; }, { once: true });
  optionalBooster.addEventListener("error", () => { rewardImageAvailable = false; }, { once: true });
  optionalBooster.src = "assets/img/booster_reward.png";

  initialize();
})();
