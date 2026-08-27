/**
 * Prints the scorer hash, so the Docker build can bake it into the image.
 *
 * The runtime stage ships compiled JS only, so `provenance.ts` has no sources
 * to hash there. Computing it in the builder — where the sources exist — and
 * passing it through as an env var keeps `/version` honest in production.
 */
import { SCORER_HASH } from "../src/verify/provenance.js";
process.stdout.write(SCORER_HASH);
