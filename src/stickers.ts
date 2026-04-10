// ─── Sticker System (VIP Group Only) ─────────────────────────────────────────
// Sticker catalog will be populated later via getStickerSet utility.

import type { MoodState } from "./config";

// ─── Sticker Catalog Entry ───────────────────────────────────────────────────

export interface StickerEntry {
  fileId: string;
  pack: "kamsqee" | "rusrusrusursur";
  emotions: MoodState[];
  description: string;
}

// ─── Catalog ─────────────────────────────────────────────────────────────────
// TODO: Populate via one-time script calling Telegram getStickerSet API

export const STICKER_CATALOG: StickerEntry[] = [
  // ─── kamsqee (72 stickers) ──────────────────────────────────────────────────
  { fileId: "CAACAgIAAxUAAWnYvtQ9YunEHvAMzAOyfeAR2WrsAAIzjgACgA7gSycB7iiGH2UzOwQ", pack: "kamsqee", emotions: ["happy", "chill"], description: "😎" },
  { fileId: "CAACAgIAAxUAAWnYvtSCieX4beclYgRcGv7VmfKoAAJojwACcVPgS71pR-8I2mBjOwQ", pack: "kamsqee", emotions: ["annoyed", "mean"], description: "😠" },
  { fileId: "CAACAgIAAxUAAWnYvtRZuRVFmsBpeEqFJqomYVDuAAJMnAAC-1rgSxtPH1AXc5ssOwQ", pack: "kamsqee", emotions: ["playful"], description: "🏀" },
  { fileId: "CAACAgIAAxUAAWnYvtTNfRJMQhcaJ6h1-uWUdH1ZAAIsjAAC70jgS8L3L-BcTcf4OwQ", pack: "kamsqee", emotions: ["playful"], description: "💸" },
  { fileId: "CAACAgIAAxUAAWnYvtTYPi5aO3W0_gtiSoaVpMPPAAJplAAC15rhS6gAAbXpU8EUjjsE", pack: "kamsqee", emotions: ["mean", "manic"], description: "🦁" },
  { fileId: "CAACAgIAAxUAAWnYvtRlcUK0K89uVUVY8o1TGkS8AAJRlQACbCHhS4VF4fFiS4jTOwQ", pack: "kamsqee", emotions: ["flirty", "playful"], description: "😏" },
  { fileId: "CAACAgIAAxUAAWnYvtRX4vPHy_DH8xDT6QLyuut-AAIikQACXYXhSxF3RYdC9c2hOwQ", pack: "kamsqee", emotions: ["happy", "chill"], description: "😎" },
  { fileId: "CAACAgIAAxUAAWnYvtQUCs3pMENhlLa21ce5bbWaAAIeogACnCHhS8cxX-vRqY1VOwQ", pack: "kamsqee", emotions: ["annoyed", "mean"], description: "😡" },
  { fileId: "CAACAgIAAxUAAWnYvtTlIq3XtVm_n5yx3ZINno7vAAJ3kwACcCLhS_xSrGOhypLjOwQ", pack: "kamsqee", emotions: ["flirty", "playful"], description: "🤴" },
  { fileId: "CAACAgIAAxUAAWnYvtTn28uOlEQ25f1946-kZ7vHAAKRkQACxiLhS-FXZNFfhk-COwQ", pack: "kamsqee", emotions: ["offended"], description: "😢" },
  { fileId: "CAACAgIAAxUAAWnYvtT04kwhGyaWOvMOz_PiHii0AAKJjgACNyPhS9-OJmHtSPIpOwQ", pack: "kamsqee", emotions: ["playful", "manic"], description: "😜" },
  { fileId: "CAACAgIAAxUAAWnYvtRbdTl37ICAYBoyt2LfxjWJAAJ9kwAC-yPhS59Fx4v3fZ8_OwQ", pack: "kamsqee", emotions: ["playful", "unhinged"], description: "🤖" },
  { fileId: "CAACAgIAAxUAAWnYvtSbBN1UiIIaW0JfCN53_suyAAIKkgACGyThS7PVE2qEVnMUOwQ", pack: "kamsqee", emotions: ["annoyed"], description: "🔻" },
  { fileId: "CAACAgIAAxUAAWnYvtTvWhzUcXcaevuTwB9qKURSAAJJnAACVCThS6l2Ag1qrIHdOwQ", pack: "kamsqee", emotions: ["happy"], description: "🔼" },
  { fileId: "CAACAgIAAxUAAWnYvtQtrAKv3WlFosId6OPQ4ppXAAJ_oQACvSThS5hVJNqkT9wuOwQ", pack: "kamsqee", emotions: ["chill"], description: "🛀" },
  { fileId: "CAACAgIAAxUAAWnYvtQbE3qm8YG9FNrddYg564XNAAJOlgACRRXhSyf88NfYjcwPOwQ", pack: "kamsqee", emotions: ["happy", "playful"], description: "🇰🇿" },
  { fileId: "CAACAgIAAxUAAWnYvtQgPO_W5BeJC5TX0g22b_gtAAKvlQACASbhS-5nLF2ot3f3OwQ", pack: "kamsqee", emotions: ["serious"], description: "👷‍♂️" },
  { fileId: "CAACAgIAAxUAAWnYvtQSw0KNEUmY5oHtgeIYZ2oSAAIxlgACXBjhSxqq-Gl2fh7cOwQ", pack: "kamsqee", emotions: ["unhinged", "manic"], description: "🤪" },
  { fileId: "CAACAgIAAxUAAWnYvtR3RlplqMZIKYNbpOj7Ssg8AAI2lAAC0wThS9W7p-Y-pGP8OwQ", pack: "kamsqee", emotions: ["chill"], description: "🖥" },
  { fileId: "CAACAgIAAxUAAWnYvtR0dbBKk8S59wrknNa0FuJyAAJjlAAC7_rhS-WJtBRF3a2sOwQ", pack: "kamsqee", emotions: ["playful", "unhinged"], description: "🇨🇳" },
  { fileId: "CAACAgIAAxUAAWnYvtQuPdb9SaSIWHeuNdvyq4YtAAIClgACIkDhS7GVZK-MqPFrOwQ", pack: "kamsqee", emotions: ["chill", "mean"], description: "🗿" },
  { fileId: "CAACAgIAAxUAAWnYvtRH2ajYMXI0X94LGeMY8V7qAAKLkAAC2yPhSyxqC32V7t6WOwQ", pack: "kamsqee", emotions: ["serious", "chill"], description: "🤔" },
  { fileId: "CAACAgIAAxUAAWnYvtSJjQ6QpYQ93xlPJwYxWflFAAJblQACGaThS_dB_aBfwPR5OwQ", pack: "kamsqee", emotions: ["flirty", "playful"], description: "💅" },
  { fileId: "CAACAgIAAxUAAWnYvtT2Hc4hVvrHU4_DjEQqteSFAAKmkwACqhfhSz7s-QEVuFX3OwQ", pack: "kamsqee", emotions: ["flirty", "playful"], description: "😏" },
  { fileId: "CAACAgIAAxUAAWnYvtT1Pz69SsqTFwq9DjyX5O58AAJYlAAC2BfhS6VDUD3Ge00POwQ", pack: "kamsqee", emotions: ["happy", "chill"], description: "😎" },
  { fileId: "CAACAgIAAxUAAWnYvtRX8ZIVxwABCWMfv1nDwMaZQAAC25MAA82H4UuGlX7RYJn_ajsE", pack: "kamsqee", emotions: ["serious", "happy"], description: "🫡" },
  { fileId: "CAACAgIAAxUAAWnYvtSZlmCUQz9brC1o7LdojP6DAAJclgACqQPiS4g1XN4PCPKkOwQ", pack: "kamsqee", emotions: ["serious", "happy"], description: "🙏" },
  { fileId: "CAACAgIAAxUAAWnYvtTktgSugLcQvH_ZOwal4WXeAAKllgACzwriS0s5LFI3sT3rOwQ", pack: "kamsqee", emotions: ["mean"], description: "🥶" },
  { fileId: "CAACAgIAAxUAAWnYvtS17jncsF8j9N1Tcy5dI20EAALIjgACu_PiSyLqJqzERVqXOwQ", pack: "kamsqee", emotions: ["happy", "playful"], description: "👏" },
  { fileId: "CAACAgIAAxUAAWnYvtTg871kaQMltIHkZd2Mha5QAAIAlQACVnbiSzLz1VDqKl6sOwQ", pack: "kamsqee", emotions: ["chill", "offended"], description: "🫥" },
  { fileId: "CAACAgIAAxUAAWnYvtTKREgXaHw-_j9oSqJ4BTQGAAJblQACvx3iS4Bz-VhxhqfmOwQ", pack: "kamsqee", emotions: ["unhinged"], description: "😳" },
  { fileId: "CAACAgIAAxUAAWnYvtSxPBdHPMjryS1i_PNNn5RxAAJQlgACn5jiS_E2VNT06N6mOwQ", pack: "kamsqee", emotions: ["offended"], description: "🤕" },
  { fileId: "CAACAgIAAxUAAWnYvtRp9SMJMsTpEj5SNDKsQeMwAALIogACu7jiS8pMrfB-SqQHOwQ", pack: "kamsqee", emotions: ["annoyed", "mean"], description: "🛑" },
  { fileId: "CAACAgIAAxUAAWnYvtSGBQVpsbQAAe52DPIvxZ04bQACxJcAAiBo4kuE4ncbM3lOvjsE", pack: "kamsqee", emotions: ["offended"], description: "😦" },
  { fileId: "CAACAgIAAxUAAWnYvtR-BUqyFEKTa6jWtte-qaCUAAKqkAACcVniS_YXfxU5k7qLOwQ", pack: "kamsqee", emotions: ["unhinged"], description: "😯" },
  { fileId: "CAACAgIAAxUAAWnYvtQK8RioR31HfKAVB8xHiSg8AAKbjgACuQrhS_FU5aXs2W8DOwQ", pack: "kamsqee", emotions: ["chill", "happy"], description: "😌" },
  { fileId: "CAACAgIAAxUAAWnYvtSErstF5JTmyoL9ODDBNpRcAAJPmgACtE7hS50eRu_N2I3JOwQ", pack: "kamsqee", emotions: ["flirty"], description: "🤤" },
  { fileId: "CAACAgIAAxUAAWnYvtSPwmYn7NGYmdNnl4p5sEygAAKZkAACA03hS_H-YAGiNI0HOwQ", pack: "kamsqee", emotions: ["chill", "unhinged"], description: "🫠" },
  { fileId: "CAACAgIAAxUAAWnYvtS7C6e0XitVuD74QcIgw739AALYmQACYVXhS3p43TmWu5NjOwQ", pack: "kamsqee", emotions: ["flirty", "playful"], description: "💅" },
  { fileId: "CAACAgIAAxUAAWnYvtT918jrOJvYBUqt1zSg48AQAAIzkQACEfrgS3kxV3B7A_L1OwQ", pack: "kamsqee", emotions: ["flirty", "playful"], description: "😏" },
  { fileId: "CAACAgIAAxUAAWnYvtROKHT_TDTLp4Dn-G6_SUYLAAKckgAC6yDhS3ZH4H8m7FZaOwQ", pack: "kamsqee", emotions: ["offended", "mean"], description: "🥀" },
  { fileId: "CAACAgIAAxUAAWnYvtRUjEldo3SmpCrjr8a1A8CCAAIhlgACXSfhS1cZQ2MOd9jKOwQ", pack: "kamsqee", emotions: ["happy", "playful"], description: "🌈" },
  { fileId: "CAACAgIAAxUAAWnYvtT7I98Sbh7F0DJRKjPSiIWJAAJgjwACXDPmS45DJYoHWqMkOwQ", pack: "kamsqee", emotions: ["chill", "playful"], description: "🤙" },
  { fileId: "CAACAgIAAxUAAWnYvtSPh8rBYgVTm8BX1F80_I9qAAKlkAACFPrmS9nH-yZTT5KMOwQ", pack: "kamsqee", emotions: ["happy", "chill"], description: "😎" },
  { fileId: "CAACAgIAAxUAAWnYvtTcN_nw6IAzXxRyrXJgaeMaAAKPkwACWBDnS7d4s2Gy-h4WOwQ", pack: "kamsqee", emotions: ["playful", "manic"], description: "💰" },
  { fileId: "CAACAgIAAxUAAWnYvtTcOGBv6dJSry07M8_EeIqrAAKBlwACHE7gS2hRiDxWj4TcOwQ", pack: "kamsqee", emotions: ["serious"], description: "🤓" },
  { fileId: "CAACAgIAAxUAAWnYvtQGV3fyswnvh0KzNielLxsQAALMogACp_jgS5Y41oYsLZkAOwQ", pack: "kamsqee", emotions: ["happy", "chill"], description: "😎" },
  { fileId: "CAACAgIAAxUAAWnYvtS0mDuXLrciGuKtqfEhrezOAAL0jgACAVHhS7kP-VHupqYcOwQ", pack: "kamsqee", emotions: ["mean", "annoyed"], description: "🤬" },
  { fileId: "CAACAgIAAxUAAWnYvtTJt5QvwOKL_KZwmaXceVTOAAKfjwACJxXhSzY68qVGJBi5OwQ", pack: "kamsqee", emotions: ["annoyed", "mean"], description: "🫸" },
  { fileId: "CAACAgIAAxUAAWnYvtTxvvpwy2A_J8NcxEgi9h4HAAKZlQAC2XThSzJqP-vfQVKwOwQ", pack: "kamsqee", emotions: ["playful", "unhinged"], description: "🤖" },
  { fileId: "CAACAgIAAxUAAWnYvtQ0Yb6ibZ_VTmFI1E7Ul4MEAAJalQACZiXhS5OdmhZWJxVTOwQ", pack: "kamsqee", emotions: ["serious", "mean"], description: "☝️" },
  { fileId: "CAACAgIAAxUAAWnYvtSdGuoGgllr9L-UZCIsJO5IAAJtkQACVzfiSxcG5S9nH0e6OwQ", pack: "kamsqee", emotions: ["playful", "serious"], description: "👀" },
  { fileId: "CAACAgIAAxUAAWnYvtT3KoTmJrn5mUlye_rlGhRoAAIiowACjA_hSxJK7UdLGXp1OwQ", pack: "kamsqee", emotions: ["annoyed", "serious"], description: "⌛️" },
  { fileId: "CAACAgIAAxUAAWnYvtSR_eVnYyZ-lNYJUVij4Tj0AAIflwACVdjgSw2fwW8atQjWOwQ", pack: "kamsqee", emotions: ["happy", "manic"], description: "💪" },
  { fileId: "CAACAgIAAxUAAWnYvtRmYM6BtGb9nKiG7aAvjdbdAAJ6lgAC1wABiEj3iGko9UejNDsE", pack: "kamsqee", emotions: ["chill", "offended"], description: "🫥" },
  { fileId: "CAACAgIAAxUAAWnYvtQCjiMXJnUMhmmj6y11MtJbAAJ6lgACRQuRSPSW0nwB4HoUOwQ", pack: "kamsqee", emotions: ["annoyed", "serious"], description: "⌛️" },
  { fileId: "CAACAgIAAxUAAWnYvtTTGpoWkGPNiuP52kF5nbcbAAJFlQACo4aJSBGgFfbopUXDOwQ", pack: "kamsqee", emotions: ["happy", "chill"], description: "☺️" },
  { fileId: "CAACAgIAAxUAAWnYvtQ8-owCTZi6KYdQU7J1EAcXAAIdkAACTTqRSAZYprcvJPKXOwQ", pack: "kamsqee", emotions: ["annoyed", "mean"], description: "🫸" },
  { fileId: "CAACAgIAAxUAAWnYvtSSm8Oc8g7uafk702MTTUfGAAIBpQACaD9YSYj5wAFpRMSkOwQ", pack: "kamsqee", emotions: ["flirty", "playful"], description: "😏" },
  { fileId: "CAACAgIAAxUAAWnYvtRblKUlG0w4d24sLzjsPsEpAALVnQACw6BYSVrqTmyy2DFtOwQ", pack: "kamsqee", emotions: ["annoyed", "mean"], description: "🛑" },
  { fileId: "CAACAgIAAxUAAWnYvtQO1aT1aDx8D9uCFcaOErBGAAKIogACfMRZSY7Ygo9Fw91GOwQ", pack: "kamsqee", emotions: ["serious", "mean"], description: "☝️" },
  { fileId: "CAACAgIAAxUAAWnYvtQhQzh8PlkDFSYpPn1v8P6zAAIVmQACS99YSWDswTfQPUi9OwQ", pack: "kamsqee", emotions: ["flirty", "playful"], description: "😏" },
  { fileId: "CAACAgIAAxUAAWnYvtRy9zjbqyIzyWd9VklsykFxAAJEnAACIP5YSQABZnLIE9qJfTsE", pack: "kamsqee", emotions: ["offended"], description: "😭" },
  { fileId: "CAACAgIAAxUAAWnYvtSI5V4b7InEhpsyR-Yus7STAALQjAACxMVhSVy7p3MiWWMnOwQ", pack: "kamsqee", emotions: ["serious", "mean"], description: "☝️" },
  { fileId: "CAACAgIAAxUAAWnYvtT7fD3Rg7W3yFuvvmZCLSCpAAJwoQACVMJhSd1rE4Ur4ZMvOwQ", pack: "kamsqee", emotions: ["annoyed", "serious"], description: "🤨" },
  { fileId: "CAACAgIAAxUAAWnYvtQiuqt07PFtI7pB-b7wPTYiAAJxmQACODVZSamnVImYIR1tOwQ", pack: "kamsqee", emotions: ["offended"], description: "😢" },
  { fileId: "CAACAgIAAxUAAWnYvtQTi-bJCDU-jMNXwvX8u37SAALeoAACA7NISgyand6CMLJjOwQ", pack: "kamsqee", emotions: ["annoyed", "offended"], description: "😕" },
  { fileId: "CAACAgIAAxUAAWnYvtR3aFzI610soSFOjNvSbu9VAAKUlQACA4dxSjamark52pGtOwQ", pack: "kamsqee", emotions: ["serious"], description: "🔍" },
  { fileId: "CAACAgIAAxUAAWnYvtQylbb03_qXSNMkpk6CiF8cAALblgAC6-F4Sjrq7mpF-TxaOwQ", pack: "kamsqee", emotions: ["chill", "flirty"], description: "🍷" },
  { fileId: "CAACAgIAAxUAAWnYvtRihA5XY4M-mFNtsUNN40PSAAIjkgACq32pSnwZ3Z7qUYd-OwQ", pack: "kamsqee", emotions: ["manic", "happy"], description: "🦅" },
  { fileId: "CAACAgIAAxUAAWnYvtRhgFqVCer-lXSzfVgtnDbOAAI8kgACZdCpSomrBETF9ggcOwQ", pack: "kamsqee", emotions: ["playful", "flirty"], description: "🤭" },
  { fileId: "CAACAgIAAxUAAWnYvtRCHuDo1j0ipcbBWHvRfcg_AAKgnQACdY2gSm4a0GP2g22hOwQ", pack: "kamsqee", emotions: ["serious", "chill"], description: "🤔" },
  // ─── rusrusrusursur (32 stickers) ───────────────────────────────────────────
  { fileId: "CAACAgIAAxUAAWnYvt8lMHQqs_Q3dPXLTGfCvFHIAAKniQACkDfYSha_ppRaubTlOwQ", pack: "rusrusrusursur", emotions: ["chill", "annoyed"], description: "🚶‍♂️" },
  { fileId: "CAACAgIAAxUAAWnYvt_ypOH-ctb6hIvvaA4TJBU6AAKCmQACldLYSkoxZljNpSYJOwQ", pack: "rusrusrusursur", emotions: ["happy", "chill"], description: "👍" },
  { fileId: "CAACAgIAAxUAAWnYvt99YlMiEwfh0EA76X-nnPMYAALigQACj4PYSqfkQeVECjfyOwQ", pack: "rusrusrusursur", emotions: ["playful", "manic"], description: "🗣" },
  { fileId: "CAACAgIAAxUAAWnYvt-Q1dmdf2ErZls61Ths_6HZAAJIpwACfb3ZSmQ_nDKOFKG4OwQ", pack: "rusrusrusursur", emotions: ["happy", "playful", "manic"], description: "🕺" },
  { fileId: "CAACAgIAAxUAAWnYvt8rsUXq1FI4odTdHSKcCIIdAAKHjwACWqHRSqIimuSovB1BOwQ", pack: "rusrusrusursur", emotions: ["offended"], description: "☹️" },
  { fileId: "CAACAgIAAxUAAWnYvt-7pOD2o_lsAAFnDS59SS77FgAC_ooAAu2O2UpTXdTxDr3edzsE", pack: "rusrusrusursur", emotions: ["annoyed", "mean"], description: "😡" },
  { fileId: "CAACAgIAAxUAAWnYvt9tisl-zQWUbUtYA__03fwDAAKFkwACzVDZSuflzZzlHr-wOwQ", pack: "rusrusrusursur", emotions: ["serious", "happy"], description: "🙏" },
  { fileId: "CAACAgIAAxUAAWnYvt9fQkNQ5Tj0t05SPr7q4G1cAAKlnAACWkzgShZm8ND2knnoOwQ", pack: "rusrusrusursur", emotions: ["happy", "chill"], description: "🤝" },
  { fileId: "CAACAgIAAxUAAWnYvt-DUo3FhBmViCn8HlSosXn_AALIkAACwNbgSgS1ijV8VYTSOwQ", pack: "rusrusrusursur", emotions: ["happy", "chill"], description: "😎" },
  { fileId: "CAACAgIAAxUAAWnYvt_JZ3s6oZ_Ld70jjZeMfzMgAAL_jgACz2zhSjq7LfMLnzBeOwQ", pack: "rusrusrusursur", emotions: ["unhinged", "playful"], description: "🏳️‍🌈" },
  { fileId: "CAACAgIAAxUAAWnYvt85h8xFCkc0-fyQKWkTSpAzAAIBlgACd3zgSjBHW3Z-xLMgOwQ", pack: "rusrusrusursur", emotions: ["mean", "manic"], description: "💣" },
  { fileId: "CAACAgIAAxUAAWnYvt8iL5LwSefRfjxO-MucA-j6AAK_kAACFF3gSqpXnSLI6pngOwQ", pack: "rusrusrusursur", emotions: ["happy", "playful", "manic"], description: "🕺" },
  { fileId: "CAACAgIAAxUAAWnYvt-7Q6ZKBrLUBTqpqNI042cnAAJGlgACo_jgSqqPSetDsjeZOwQ", pack: "rusrusrusursur", emotions: ["playful", "manic"], description: "🗣️" },
  { fileId: "CAACAgIAAxUAAWnYvt8aYONkOLjsUa7tifYX_tSjAAItigACfJkJSyfi9gbjQNNiOwQ", pack: "rusrusrusursur", emotions: ["playful", "serious"], description: "👀" },
  { fileId: "CAACAgIAAxUAAWnYvt-noYvsYhPeWjg-xCrN8JDOAAJEkwACPokJS5y6Zkgfr3aJOwQ", pack: "rusrusrusursur", emotions: ["playful", "manic"], description: "🏃‍♂️" },
  { fileId: "CAACAgIAAxUAAWnYvt9uG893JCWHteMbarmKVSrEAALhlgAC0oIIS1YvKmlAi5lpOwQ", pack: "rusrusrusursur", emotions: ["mean", "annoyed"], description: "👊" },
  { fileId: "CAACAgIAAxUAAWnYvt-EKVyBSaTQp6xOQsQqLtJZAAL-mAAC8LpxSzzkDZrhzBCoOwQ", pack: "rusrusrusursur", emotions: ["happy", "playful", "manic"], description: "🕺" },
  { fileId: "CAACAgIAAxUAAWnYvt9t5oz1q-vw189hPT_k_LWFAAL4nAACvrdxS7mDfP4NL1uNOwQ", pack: "rusrusrusursur", emotions: ["playful", "unhinged"], description: "🤖" },
  { fileId: "CAACAgIAAxUAAWnYvt9u7FJRWgT9jmYTFN3RxhV_AAK3kgACGQ6gS58jkaBUZ50dOwQ", pack: "rusrusrusursur", emotions: ["annoyed", "mean"], description: "😡" },
  { fileId: "CAACAgIAAxUAAWnYvt8cvaBf92KF5fk-tIsoG9ynAAIUlgACy2G5S8fTl48MKH-NOwQ", pack: "rusrusrusursur", emotions: ["happy", "manic"], description: "💪" },
  { fileId: "CAACAgIAAxUAAWnYvt8H4J2tv8AUpWQb9KQjxPmJAAKUkQAC41m4S-Sj8gMrd614OwQ", pack: "rusrusrusursur", emotions: ["happy", "chill"], description: "😎" },
  { fileId: "CAACAgIAAxUAAWnYvt8hVNWDwZ_hXUfcWxUojXLlAAKekgACWQG5S2IkelMfBhwzOwQ", pack: "rusrusrusursur", emotions: ["annoyed", "offended"], description: "😑" },
  { fileId: "CAACAgIAAxUAAWnYvt8gdOoCyji5MaNm7lIdwO_xAAK7mQACIP1oSBx0oXjvtTz0OwQ", pack: "rusrusrusursur", emotions: ["mean", "unhinged"], description: "💀" },
  { fileId: "CAACAgIAAxUAAWnYvt_N5xBlx0wt6cKeZEZP0HEwAAK-owAC3ljYSEXPqvMTUxBKOwQ", pack: "rusrusrusursur", emotions: ["happy", "playful"], description: "🤣" },
  { fileId: "CAACAgIAAxUAAWnYvt9KTpjPuiyn3ggaRte2RHaZAAKlkAAC2VroSNZ0TiMrghu-OwQ", pack: "rusrusrusursur", emotions: ["serious", "happy"], description: "🙏" },
  { fileId: "CAACAgIAAxUAAWnYvt-y2vXRw86CPiwj4BbZ9kHNAAKEmwAC08_pSEHH4a10HaStOwQ", pack: "rusrusrusursur", emotions: ["happy", "playful", "manic"], description: "🕺" },
  { fileId: "CAACAgIAAxUAAWnYvt-npsM--cO5ZOT7eFkwcItNAALwkgACJu3wSKUMh4lF6PGZOwQ", pack: "rusrusrusursur", emotions: ["unhinged", "manic"], description: "🤪" },
  { fileId: "CAACAgIAAxUAAWnYvt83aCWciUHiU3GOs4caG2SuAAJfkgACknrxSL6FlvH4_RXmOwQ", pack: "rusrusrusursur", emotions: ["playful", "manic"], description: "🗣️" },
  { fileId: "CAACAgIAAxUAAWnYvt_fijwyN3WOhpCx_z_Lou-pAAJMkwACtBxJScQ8ncDxjzQYOwQ", pack: "rusrusrusursur", emotions: ["happy", "playful"], description: "😂" },
  { fileId: "CAACAgIAAxUAAWnYvt9vsK5kc0DlXKGwRyXYJu2nAAKZVwEAAbTbsEmr7addP201VDsE", pack: "rusrusrusursur", emotions: ["happy", "playful", "manic"], description: "🕺" },
  { fileId: "CAACAgIAAxUAAWnYvt_ud6ynSiVhquVCExBiqjAoAALlmAAC1eOgSpuViPUtg9CkOwQ", pack: "rusrusrusursur", emotions: ["offended", "unhinged"], description: "😨" },
  { fileId: "CAACAgIAAxUAAWnYvt9pQYpXRoCFZkGosQelSK2YAAL5nAACtjCgSv0YtFKbmHDQOwQ", pack: "rusrusrusursur", emotions: ["offended", "chill"], description: "😶" },
];

// ─── Pick Sticker by Mood ────────────────────────────────────────────────────

export function pickStickerForMood(mood: MoodState): StickerEntry | null {
  if (STICKER_CATALOG.length === 0) return null;

  // Find stickers matching current mood
  const matching = STICKER_CATALOG.filter((s) => s.emotions.includes(mood));

  if (matching.length > 0) {
    return matching[Math.floor(Math.random() * matching.length)];
  }

  // Fallback: random sticker
  return STICKER_CATALOG[Math.floor(Math.random() * STICKER_CATALOG.length)];
}

// ─── Parse Sticker Tag from LLM Response ─────────────────────────────────────
// LLM may output [STICKER:happy] in its response

export function extractStickerTag(text: string): { cleanText: string; emotion: string | null } {
  const match = text.match(/\[STICKER:(\w+)\]/i);

  if (!match) return { cleanText: text, emotion: null };

  return {
    cleanText: text.replace(match[0], "").trim(),
    emotion: match[1].toLowerCase(),
  };
}
