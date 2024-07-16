import dotenv from "dotenv";
import * as core from "@actions/core";
import * as github from "@actions/github";
import axios from "axios";
import * as fs from "fs";
import * as path from "path";

const ACTION_NAME = "[Weglot-i18n File Generator]";
const WEGLOT_BASE_URL = "https://api.weglot.com";
const USER_AGENT = "PostmanRuntime/7.37.3";

dotenv.config();

async function translateArray(
  apiKey: string,
  requestUrl: string,
  from: string,
  to: string,
  content: string[]
) {
  const words: { w: string; t: 1 }[] = [];

  content.map((c) => {
    //remove any replaceables
    const replaceables = c.match(/{{(.*?)}}/g);
    if (replaceables) {
      replaceables.forEach((replaceable, index) => {
        c = c.replace(replaceable, `{{${index + 1}}}`);
      });
    }

    words.push({ w: c, t: 1 });
  });

  const weglotTranslateResult = await axios.post(
    `${WEGLOT_BASE_URL}/translate?api_key=${apiKey}`,
    {
      l_from: from,
      l_to: to,
      title: "",
      request_url: requestUrl,
      bot: 0,
      words: words,
    },
    {
      headers: {
        "User-Agent": USER_AGENT,
      },
    }
  );
  return {
    asRequested: words.map((word: any) => word.w),
    asTranslated: weglotTranslateResult.data.to_words,
  };
}

function collectValues(obj: any, values: string[]): void {
  if (typeof obj !== "object" || obj === null) {
    return;
  }

  for (const key in obj) {
    if (obj.hasOwnProperty(key)) {
      if (Array.isArray(obj[key])) {
        obj[key].forEach((item: any) => {
          if (typeof item === "object" && item !== null) {
            collectValues(item, values);
          } else {
            values.push(item);
          }
        });
      } else if (typeof obj[key] === "object" && obj[key] !== null) {
        collectValues(obj[key], values);
      } else {
        values.push(obj[key]);
      }
    }
  }
}

function replaceValuesWithTranslatedValues(
  obj: any,
  valueMap: Map<
    string,
    {
      asOriginal: string;
      asRequested: string;
      asTranslated: string;
    }
  >
): any {
  if (typeof obj !== "object" || obj === null) {
    return obj;
  }

  const result: any = {};

  for (const key in obj) {
    if (obj.hasOwnProperty(key)) {
      if (Array.isArray(obj[key])) {
        result[key] = obj[key].map((item: any) => {
          if (typeof item === "object" && item !== null) {
            return replaceValuesWithTranslatedValues(item, valueMap);
          }
          return valueMap.get(item) || item;
        });
      } else if (typeof obj[key] === "object" && obj[key] !== null) {
        result[key] = replaceValuesWithTranslatedValues(obj[key], valueMap);
      } else {
        const value = valueMap.get(obj[key]) || obj[key];

        //take the translated value and replace the placeholders with the original values
        let translatedValue = value.asTranslated;
        const replaceables = value.asOriginal.match(/{{(.*?)}}/g);
        if (replaceables) {
          replaceables.forEach((replaceable: any, index: any) => {
            translatedValue = translatedValue.replace(
              `{{${index + 1}}}`,
              replaceable
            );
          });
        }

        result[key] = translatedValue;
      }
    }
  }

  return result;
}

async function run() {
  dotenv.config();

  core.info(`${ACTION_NAME} Starting up...`);

  const WEGLOT_API_KEY = process.env.WEGLOT_API_KEY;

  if (!WEGLOT_API_KEY) {
    core.setFailed(`${ACTION_NAME} WEGLOT_API_KEY is required`);
    return;
  }

  const WEGLOT_REQUEST_URL = process.env.WEGLOT_REQUEST_URL;

  if (!WEGLOT_REQUEST_URL) {
    core.setFailed(`${ACTION_NAME} WEGLOT_REQUEST_URL is required`);
    return;
  }

  const LOCALES_DIR = process.env.LOCALES_DIR;

  if (!LOCALES_DIR) {
    core.setFailed(`${ACTION_NAME} LOCALES_DIR is required`);
    return;
  }

  let WORKING_DIR = process.env.WORKING_DIR;

  if (!WORKING_DIR) {
    WORKING_DIR = process.env.GITHUB_WORKSPACE ?? __dirname;
  }

  const localesdir = path.join(WORKING_DIR, LOCALES_DIR);
  core.info(
    `${ACTION_NAME} Translation files will be placed in: ${localesdir}`
  );

  const WEGLOT_PROJECT_ID = WEGLOT_API_KEY.replace("wg_", "");

  //Let's check if the weglot API is up and available
  // core.info(`${ACTION_NAME} Checking Weglot API status...`);
  // const weglotApiStatus = await axios.get(`${WEGLOT_BASE_URL}/public/status`, {
  //   headers: {
  //     "User-Agent": USER_AGENT,
  //   },
  // });

  // if (weglotApiStatus.status !== 200) {
  //   core.setFailed(
  //     `${ACTION_NAME} We encountered an error while trying to connect to the Weglot API. Please try again later.`
  //   );
  //   return;
  // }

  core.info(`${ACTION_NAME} Getting Weglot project settings...`);
  const weglotProjectSettingsRequest = await axios.get(
    `https://cdn.weglot.com/projects-settings/${WEGLOT_PROJECT_ID}.json`,
    {
      headers: {
        "User-Agent": USER_AGENT,
      },
    }
  );

  const weglotProjectSettings = weglotProjectSettingsRequest.data;

  const weglotOriginalLanguage = weglotProjectSettings.language_from;
  const supportedWeglotLanguages: string[] = [];
  (weglotProjectSettings.languages ?? []).map((lang: any) => {
    if (lang.enabled) {
      supportedWeglotLanguages.push(lang.language_to);
    }
  });

  core.info(
    `${ACTION_NAME} Original Language: ${weglotOriginalLanguage}, Translating to ${supportedWeglotLanguages.length} languages (${supportedWeglotLanguages})!`
  );

  //read the orignal language json file
  core.info(`${ACTION_NAME} Reading original language json file...`);
  const originalFileContent = fs.readFileSync(
    path.join(localesdir, `${weglotOriginalLanguage}.json`),
    "utf8"
  );
  const originalI18NFile = JSON.parse(originalFileContent);

  // Collect all values
  const values: string[] = [];
  collectValues(originalI18NFile, values);

  core.info(`${ACTION_NAME} Starting Translation...`);
  for (const lang of supportedWeglotLanguages) {
    core.info(`${ACTION_NAME} Translating to ${lang}...`);
    // Translate values
    const translationResult = await translateArray(
      WEGLOT_API_KEY,
      WEGLOT_REQUEST_URL,
      weglotOriginalLanguage,
      lang,
      values
    );

    // Create a map from original values to translated values
    const valueMap = new Map<
      string,
      { asOriginal: string; asRequested: string; asTranslated: string }
    >();
    values.forEach((value, index) => {
      valueMap.set(value, {
        asOriginal: value,
        asRequested: translationResult.asRequested[index],
        asTranslated: translationResult.asTranslated[index],
      });
    });

    // Replace values with translated values
    const resultData = replaceValuesWithTranslatedValues(
      originalI18NFile,
      valueMap
    );

    const jsonContent = JSON.stringify(resultData, null, 2);
    fs.writeFileSync(
      path.join(localesdir, `${lang}.json`),
      jsonContent,
      "utf8"
    );
  }
}

run().catch((error) => {
  console.log(error);
  core.setFailed("Workflow failed! " + error.message);
});
