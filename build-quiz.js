const XLSX = require('xlsx');
const path = require('path');
const fs = require('fs');

// 1. Define the 16 structured questions from the user's Excel file
const questions = [
  {
    id: 1,
    question: "Where was the first place the couple traveled together?",
    timeLimit: 20,
    options: ["Paete", "Tagaytay", "Cebu", "Dubai"],
    correctIndex: 0, // Paete (note: adjust if different)
    explanation: "Their very first trip together was to Paete!"
  },
  {
    id: 2,
    question: "What is the couple's favorite fast-food chain?",
    timeLimit: 20,
    options: ["Jollibee", "McDonald's", "KFC", "Wendy's"],
    correctIndex: 0, // Jollibee ✅
    explanation: "Jollibee is their favorite, and where they had their first date!"
  },
  {
    id: 3,
    question: "Anong dream adventure ng couple?",
    timeLimit: 20,
    options: ["Skydiving", "Paragliding", "Bungee Jumping", "Hike Mt. Apo"],
    correctIndex: 0, // Skydiving
    explanation: "They already conquered Paragliding and Mt. Pulag—next is Skydiving!"
  },
  {
    id: 4,
    question: "Sino ang unang nag-message?",
    timeLimit: 15,
    options: ["The Groom", "The Bride", "Both at the same time", "Mutual friend initiated"],
    correctIndex: 0, // Groom
    explanation: "The Groom made the first bold move!"
  },
  {
    id: 5,
    question: "What is the couple's dream travel destination?",
    timeLimit: 20,
    options: ["Japan", "China", "Switzerland", "India"],
    correctIndex: 2, // Switzerland
    explanation: "Their ultimate dream escape is Switzerland!"
  },
  {
    id: 6,
    question: "Where did the couple first meet?",
    timeLimit: 20,
    options: ["School", "Work", "Through friends", "Online"],
    correctIndex: 0, // School ✅
    explanation: "They first met back in School!"
  },
  {
    id: 7,
    question: "How long did the Groom court the Bride?",
    timeLimit: 20,
    options: ["1 year", "8 months", "5 months", "3 months"],
    correctIndex: 1, // 8 months
    explanation: "Patience pays off: 8 months of sweet courtship!"
  },
  {
    id: 8,
    question: "What is their favorite activity together?",
    timeLimit: 20,
    options: ["Traveling", "Gaming", "Hiking", "Sleeping"],
    correctIndex: 0, // Traveling ✅
    explanation: "Exploring the world together is their #1 passion!"
  },
  {
    id: 9,
    question: "What month did the proposal happen?",
    timeLimit: 20,
    options: ["February", "May", "July", "December"],
    correctIndex: 2, // July ✅
    explanation: "The unforgettable Taiwan proposal happened in July!"
  },
  {
    id: 10,
    question: "How many countries have they traveled to together?",
    timeLimit: 20,
    options: ["6", "5", "4", "7"],
    correctIndex: 0, // 6 ✅
    explanation: "6 passport stamps together and counting!"
  },
  {
    id: 11,
    question: "What is the couple's sweet call sign for each other?",
    timeLimit: 15,
    options: ["Loves", "Babe", "Honey", "Sweetheart"],
    correctIndex: 0, // Loves ✅ (from facts sheet)
    explanation: "They lovingly call each other 'Loves'!"
  },
  {
    id: 12,
    question: "Where did their unforgettable proposal take place?",
    timeLimit: 20,
    options: ["Taiwan", "Dubai", "Japan", "Palawan"],
    correctIndex: 0, // Taiwan ✅ (from facts sheet)
    explanation: "He popped the question during their trip to Taiwan!"
  },
  {
    id: 13,
    question: "What is the chemical symbol for gold?",
    timeLimit: 15,
    options: ["Go", "Gd", "Au", "Ag"],
    correctIndex: 2, // Au ✅
    explanation: "Au (from Latin Aurum) represents pure gold like their wedding rings!"
  },
  {
    id: 14,
    question: "Which gas do plants absorb from the atmosphere?",
    timeLimit: 15,
    options: ["Oxygen", "Carbon Dioxide", "Nitrogen", "Hydrogen"],
    correctIndex: 1, // Carbon Dioxide ✅
    explanation: "Plants absorb Carbon Dioxide (CO2) during photosynthesis!"
  },
  {
    id: 15,
    question: "Water boils at what temperature at sea level?",
    timeLimit: 15,
    options: ["90°C", "95°C", "100°C", "110°C"],
    correctIndex: 2, // 100°C ✅
    explanation: "Pure water boils at exactly 100°C at 1 atm pressure!"
  },
  {
    id: 16,
    question: "What is the Ideal Gas Equation?",
    timeLimit: 20,
    options: ["PV = mRT", "F = ma", "P = ρgh", "Q = mcΔT"],
    correctIndex: 0, // PV = mRT ✅
    explanation: "PV = mRT is the fundamental gas state relation!"
  },
  {
    id: 17,
    question: "What is the value of π (pi) rounded to 4 decimal places?",
    timeLimit: 15,
    options: ["3.1415", "3.1416", "3.1426", "3.4116"],
    correctIndex: 1, // 3.1416 ✅
    explanation: "3.14159... rounds up to 3.1416!"
  },
  {
    id: 18,
    question: "How many bones does an adult human body have?",
    timeLimit: 15,
    options: ["206", "201", "212", "196"],
    correctIndex: 0, // 206 ✅
    explanation: "An adult human skeleton consists of 206 bones!"
  }
];

// Save to web app questions.json
const appQuestionsPath = path.join(__dirname, 'questions.json');
fs.writeFileSync(appQuestionsPath, JSON.stringify(questions, null, 2), 'utf8');
console.log(`Saved ${questions.length} questions to questions.json`);

// 2. Generate official Kahoot Excel template file
const kahootRows = [
  // Kahoot official header layout
  ["Kahoot! Quiz Spreadsheet Template"],
  [],
  ["Questions must not exceed 120 characters."],
  ["Answers must not exceed 75 characters."],
  [],
  ["Question", "Answer 1", "Answer 2", "Answer 3", "Answer 4", "Time limit (sec)", "Correct answer(s)"]
];

questions.forEach(q => {
  kahootRows.push([
    q.question,
    q.options[0] || "",
    q.options[1] || "",
    q.options[2] || "",
    q.options[3] || "",
    q.timeLimit || 20,
    q.correctIndex + 1 // Kahoot is 1-indexed (1, 2, 3, 4)
  ]);
});

const wb = XLSX.utils.book_new();
const ws = XLSX.utils.aoa_to_sheet(kahootRows);
XLSX.utils.book_append_sheet(wb, ws, "KahootTemplate");

const desktopOutputPath = 'C:/Users/Dell 5420/Desktop/Kahoot_Import_Ready_B&S_Wedding.xlsx';
XLSX.writeFile(wb, desktopOutputPath);
console.log(`Saved Kahoot upload file to ${desktopOutputPath}`);
