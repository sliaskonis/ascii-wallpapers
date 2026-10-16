/*
 * ocean: the open sea to the horizon, in one line. A recipe from the kit,
 * made the shape of the screen: 192 by 54 characters is 16 by 9, a character
 * being twice as tall as it is wide, and ten pixels a column at 1920 across.
 *
 * Try another look (plasma, aurora, flames, clouds, matrix, galaxy), another
 * palette (sunset, neon, fire, ice, night) or a speed: sea({ speed: "slow" }).
 */
import { sea } from "ascii.rest/kit";

export default sea({ palette: "ocean" }).size(192, 54);
