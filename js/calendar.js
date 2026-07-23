// ==========================================================
// 自作カレンダー(日付選択) ― 他のモジュールに依存しない独立部品
// ==========================================================

let calendarTargetInput = null;
let calendarViewDate = new Date();

function formatDateYMD(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return y + "-" + m + "-" + day;
}

function openCalendar(targetInput) {
  calendarTargetInput = targetInput;
  const existing = targetInput.value;
  calendarViewDate = existing ? new Date(existing + "T00:00:00") : new Date();
  document.getElementById("yearmonth-picker").classList.add("hidden");
  document.getElementById("calendar-grid").classList.remove("hidden");
  renderCalendar();
  document.getElementById("calendar-overlay").classList.remove("hidden");
}

function closeCalendar() {
  document.getElementById("calendar-overlay").classList.add("hidden");
  document.getElementById("yearmonth-picker").classList.add("hidden");
  document.getElementById("calendar-grid").classList.remove("hidden");
  calendarTargetInput = null;
}

function renderCalendar() {
  const year = calendarViewDate.getFullYear();
  const month = calendarViewDate.getMonth();
  document.getElementById("cal-month-label").textContent = year + "年" + (month + 1) + "月";

  const firstDay = new Date(year, month, 1);
  const startWeekday = firstDay.getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const selectedValue = calendarTargetInput ? calendarTargetInput.value : "";
  const todayStr = formatDateYMD(new Date());

  const dows = ["日", "月", "火", "水", "木", "金", "土"];
  let html = dows.map(d => `<div class="cal-dow">${d}</div>`).join("");

  for (let i = 0; i < startWeekday; i++) html += `<div class="cal-day empty"></div>`;

  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = formatDateYMD(new Date(year, month, d));
    let cls = "cal-day";
    if (dateStr === selectedValue) cls += " selected";
    if (dateStr === todayStr) cls += " today";
    html += `<div class="${cls}" data-date="${dateStr}">${d}</div>`;
  }

  document.getElementById("calendar-grid").innerHTML = html;

  document.querySelectorAll("#calendar-grid .cal-day:not(.empty)").forEach(el => {
    el.addEventListener("click", () => {
      if (calendarTargetInput) {
        calendarTargetInput.value = el.dataset.date;
        // 呼び出し元がchangeイベントを監視して反応できるようにする(値の直接代入だけでは発火しないため)
        calendarTargetInput.dispatchEvent(new Event("change", { bubbles: true }));
      }
      closeCalendar();
    });
  });
}

document.getElementById("cal-prev").addEventListener("click", () => {
  calendarViewDate = new Date(calendarViewDate.getFullYear(), calendarViewDate.getMonth() - 1, 1);
  document.getElementById("yearmonth-picker").classList.add("hidden");
  document.getElementById("calendar-grid").classList.remove("hidden");
  renderCalendar();
});
document.getElementById("cal-next").addEventListener("click", () => {
  calendarViewDate = new Date(calendarViewDate.getFullYear(), calendarViewDate.getMonth() + 1, 1);
  document.getElementById("yearmonth-picker").classList.add("hidden");
  document.getElementById("calendar-grid").classList.remove("hidden");
  renderCalendar();
});

const yearSelect = document.getElementById("cal-year-select");
const monthSelect = document.getElementById("cal-month-select");
for (let m = 1; m <= 12; m++) {
  const opt = document.createElement("option");
  opt.value = m;
  opt.textContent = m + "月";
  monthSelect.appendChild(opt);
}

document.getElementById("cal-month-label").addEventListener("click", () => {
  const realCurrentYear = new Date().getFullYear();
  const viewYear = calendarViewDate.getFullYear();
  yearSelect.innerHTML = "";
  for (let y = realCurrentYear; y <= realCurrentYear + 10; y++) {
    const opt = document.createElement("option");
    opt.value = y;
    opt.textContent = y + "年";
    if (y === viewYear) opt.selected = true;
    yearSelect.appendChild(opt);
  }
  monthSelect.value = calendarViewDate.getMonth() + 1;

  document.getElementById("yearmonth-picker").classList.remove("hidden");
  document.getElementById("calendar-grid").classList.add("hidden");
});

function applyYearMonthSelection() {
  calendarViewDate = new Date(Number(yearSelect.value), Number(monthSelect.value) - 1, 1);
  document.getElementById("yearmonth-picker").classList.add("hidden");
  document.getElementById("calendar-grid").classList.remove("hidden");
  renderCalendar();
}
yearSelect.addEventListener("change", applyYearMonthSelection);
monthSelect.addEventListener("change", applyYearMonthSelection);
document.getElementById("cal-clear").addEventListener("click", () => {
  if (calendarTargetInput) {
    calendarTargetInput.value = "";
    calendarTargetInput.dispatchEvent(new Event("change", { bubbles: true }));
  }
  closeCalendar();
});
document.getElementById("cal-close").addEventListener("click", closeCalendar);
document.getElementById("calendar-overlay").addEventListener("click", (e) => {
  if (e.target.id === "calendar-overlay") closeCalendar();
});

document.addEventListener("click", (e) => {
  if (e.target.classList && e.target.classList.contains("date-display")) {
    openCalendar(e.target);
  }
});
