import {
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
mkdirSync(".local", { recursive: true, mode: 0o700 });
const path = ".local/lab-users.json";
if (!existsSync(path))
  writeFileSync(
    path,
    JSON.stringify(
      [
        {
          email: "lab-human@example.invalid",
          first_name: "Shouss (Lab)",
          last_name: "",
          password: randomBytes(24).toString("base64url"),
        },
        {
          email: "lab-agent@example.invalid",
          first_name: "Shouss 的 Agent (Lab)",
          last_name: "",
          password: randomBytes(24).toString("base64url"),
        },
        {
          email: "lab-outsider@example.invalid",
          first_name: "Outsider (Lab)",
          last_name: "",
          password: randomBytes(24).toString("base64url"),
        },
      ],
      null,
      2,
    ),
    { mode: 0o600 },
  );
chmodSync(path, 0o600);
const script = `
import Registration from './app/src/Features/User/UserRegistrationHandler.mjs';
import Getter from './app/src/Features/User/UserGetter.mjs';
let input=''; for await(const b of process.stdin) input+=b;
try {
 const users=JSON.parse(input), result=[];
 for(const details of users) {
  let user=await Getter.promises.getUserByAnyEmail(details.email);
  if(!user) user=await Registration.promises.registerNewUser(details);
  result.push({email:details.email,id:String(user._id)});
 }
 console.log('LAB_USERS='+JSON.stringify(result));process.exit(0);
} catch(e) {console.error(e);process.exit(1);}
`;
try {
  const output = execFileSync(
    "docker",
    [
      "compose",
      "exec",
      "-T",
      "-w",
      "/overleaf/services/web",
      "overleaf",
      "node",
      "--input-type=module",
      "-e",
      script,
    ],
    {
      input: readFileSync(path),
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  writeFileSync(".local/bootstrap.log", output, { mode: 0o600 });
  const line = output.split("\n").find((l) => l.startsWith("LAB_USERS="));
  if (!line) throw new Error("No account result");
  const agent = JSON.parse(readFileSync(path, "utf8"))[1];
  if (!existsSync(".local/client.json"))
    writeFileSync(
      ".local/client.json",
      JSON.stringify(
        {
          baseUrl: "http://127.0.0.1:18080",
          email: agent.email,
          password: agent.password,
          allowedProjectIds: [],
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
  console.log(line);
} catch (e) {
  writeFileSync(".local/bootstrap-error.log", String(e.stderr ?? e), {
    mode: 0o600,
  });
  console.error("Lab bootstrap failed; inspect .local/bootstrap-error.log");
  process.exitCode = 1;
}
