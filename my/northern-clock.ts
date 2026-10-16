/*
 * northern clock: the time, on a clock face, under northern lights. Three
 * recipes put together: add() lays one look over another, and behind() puts
 * any piece in the middle of a look. `real` makes the clock show your time,
 * and `mask: null` keeps the sky from showing through its face.
 */
import { aurora, clockFace, stars } from "ascii.rest/kit";

const sky = aurora({ speed: "slow" }).add(stars({ density: "sparse" })).size(192, 54);

export default sky.behind(clockFace({ real: true, size: "large" }), { mask: null });
