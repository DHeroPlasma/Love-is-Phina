/**
 * Creates decorative animated hearts inside a given container.
 */
class HeartDecoration {

  constructor(containerId, options = {}) {
    this.container =
      document.getElementById(containerId);

    this.heartCount =
      options.heartCount ?? 40;

    this.minSize =
      options.minSize ?? 30;

    this.maxSize =
      options.maxSize ?? 100;

    this.minOpacity =
      options.minOpacity ?? 0.15;

    this.maxOpacity =
      options.maxOpacity ?? 0.4;

    this.minDuration =
      options.minDuration ?? 4;

    this.maxDuration =
      options.maxDuration ?? 9;
  }


  /**
   * Creates all decorative hearts.
   */
  create() {
    if (!this.container) {
      console.warn(
        "HeartDecoration: Container not found."
      );

      return;
    }

    for (
      let i = 0;
      i < this.heartCount;
      i++
    ) {
      const heart =
        this.createHeart();

      this.container.appendChild(heart);
    }
  }


  /**
   * Creates a single heart element.
   */
  createHeart() {
    const heart =
      document.createElement("div");

    heart.classList.add(
      "heart-decoration"
    );

    heart.textContent = "♥";

    // Random position
    heart.style.left =
      `${this.random(0, 100)}%`;

    heart.style.top =
      `${this.random(0, 100)}%`;

    // Random size
    heart.style.fontSize =
      `${this.random(
        this.minSize,
        this.maxSize
      )}px`;

    // Random opacity
    heart.style.opacity =
      this.random(
        this.minOpacity,
        this.maxOpacity
      );

    // Random animation speed
    heart.style.animationDuration =
      `${this.random(
        this.minDuration,
        this.maxDuration
      )}s`;

    // Random animation starting point
    heart.style.animationDelay =
      `${this.random(0, 5)}s`;

    return heart;
  }


  /**
   * Returns a random number between min and max.
   */
  random(min, max) {
    return (
      min +
      Math.random() * (max - min)
    );
  }
}