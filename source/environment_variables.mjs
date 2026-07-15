import dotenv from "dotenv";
import { join } from "node:path";
import { paperman_home_directory_path } from "./paperman_home_files.mjs";

process.env.DOTENV_CONFIG_QUIET = "true";
dotenv.config({ path: ".env", quiet: true });
dotenv.config({ path: join(paperman_home_directory_path(), ".env"), quiet: true });
