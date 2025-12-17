const { exec } = require("child_process");
const { promisify } = require("util");
const path = require("path");
const fs = require("fs");

const execPromise = promisify(exec);

async function runWithLog(command, label) {
  console.log(`\n📦 ${label}...`);
  try {
    const { stdout, stderr } = await execPromise(command, {
      cwd: path.join(__dirname, ".."),
      shell: true,
    });

    if (stdout) console.log(`  ${stdout}`);
    if (stderr && !stderr.includes("npm WARN")) {
      console.log(`  ⚠️  ${stderr}`);
    }
    console.log(`  ✅ ${label} completed`);
    return true;
  } catch (error) {
    console.error(`  ❌ Error in ${label}:`, error.message);
    return false;
  }
}

async function checkDependencies() {
  console.log("🔍 Checking dependencies...");
  try {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")
    );

    const totalDeps =
      Object.keys(packageJson.dependencies || {}).length +
      Object.keys(packageJson.devDependencies || {}).length;
    console.log(`  📊 Found ${totalDeps} dependencies in package.json`);
    return true;
  } catch (error) {
    console.error("  ❌ Cannot read package.json");
    return false;
  }
}

async function setupAll() {
  console.log("🚀 Starting comprehensive setup for Quran Bot\n");
  console.log("=".repeat(50));

  // 1. Установка зависимостей
  console.log("\n1️⃣  INSTALLING DEPENDENCIES");
  console.log("-".repeat(30));

  await runWithLog("npm install", "Installing npm packages");

  // 2. Проверка зависимостей
  console.log("\n2️⃣  VERIFYING INSTALLATION");
  console.log("-".repeat(30));

  await checkDependencies();

  // Проверка основных модулей
  const modules = ["sqlite3", "telegraf", "dotenv"];
  for (const module of modules) {
    try {
      require(module);
      console.log(`  ✅ ${module} is available`);
    } catch (error) {
      console.log(`  ❌ ${module} failed to load: ${error.message}`);
    }
  }

  // 3. Инициализация баз данных (параллельно)
  console.log("\n3️⃣  INITIALIZING DATABASES");
  console.log("-".repeat(30));

  const dbScripts = [
    { cmd: "npm run dbTranslations", label: "Translations DB" },
    { cmd: "npm run dbKeys", label: "Keys DB" },
    { cmd: "npm run dbTafsir", label: "Tafsir DB" },
    { cmd: "npm run dbUsers", label: "Users DB" },
    { cmd: "npm run dbAyahPhotos", label: "Ayah Photos DB" },
  ];

  const dbResults = await Promise.allSettled(
    dbScripts.map(({ cmd, label }) => runWithLog(cmd, label))
  );

  const dbSuccess = dbResults.filter(
    (r) => r.status === "fulfilled" && r.value
  ).length;
  console.log(
    `  📊 ${dbSuccess}/${dbScripts.length} databases initialized successfully`
  );

  // 4. Запуск тестов
  console.log("\n4️⃣  RUNNING TESTS");
  console.log("-".repeat(30));

  const testScripts = [
    { cmd: "npm run test-tr", label: "Translations Test" },
    { cmd: "npm run test-ke", label: "Keys Test" },
    { cmd: "npm run test-ta", label: "Tafsir Test" },
    { cmd: "npm run test-us", label: "Users Test" },
    { cmd: "npm run test-im", label: "Images Test" },
  ];

  const testResults = await Promise.allSettled(
    testScripts.map(({ cmd, label }) => runWithLog(cmd, label))
  );

  const testSuccess = testResults.filter(
    (r) => r.status === "fulfilled" && r.value
  ).length;
  console.log(`  📊 ${testSuccess}/${testScripts.length} tests passed`);

  // 5. Финальный отчет
  console.log("\n" + "=".repeat(50));
  console.log("📋 SETUP COMPLETE - SUMMARY");
  console.log("=".repeat(50));
  console.log(`✅ Dependencies: Installed`);
  console.log(`✅ Databases: ${dbSuccess}/${dbScripts.length} initialized`);
  console.log(`✅ Tests: ${testSuccess}/${testScripts.length} passed`);

  if (dbSuccess === dbScripts.length && testSuccess === testScripts.length) {
    console.log("\n🎉 ALL SYSTEMS GO! Bot is ready to run.");
    console.log("👉 Start with: npm start");
  } else {
    console.log("\n⚠️  Some components had issues. Check logs above.");
    console.log("👉 You can still try: npm start");
  }

  console.log("\n💡 Quick commands:");
  console.log("  npm start      - Start the bot");
  console.log("  npm run dev    - Start in development mode");
  console.log("  npm run db:all-parallel - Re-initialize all DBs");
}

// Обработка ошибок верхнего уровня
setupAll().catch((error) => {
  console.error("🔥 Fatal error during setup:", error);
  process.exit(1);
});
