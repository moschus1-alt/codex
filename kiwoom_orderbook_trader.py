import sys
from dataclasses import dataclass
from datetime import datetime
from typing import List

from matplotlib.backends.backend_qt5agg import FigureCanvasQTAgg as FigureCanvas
from matplotlib.figure import Figure
from matplotlib.patches import Rectangle
from PyQt5.QAxContainer import QAxWidget
from PyQt5.QtWidgets import (
    QApplication,
    QComboBox,
    QFormLayout,
    QGridLayout,
    QGroupBox,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QMainWindow,
    QMessageBox,
    QPushButton,
    QSplitter,
    QTableWidget,
    QTableWidgetItem,
    QVBoxLayout,
    QWidget,
)


@dataclass
class QuoteLevel:
    ask_price: int
    ask_volume: int
    bid_price: int
    bid_volume: int


@dataclass
class Candle:
    dt: datetime
    open: int
    high: int
    low: int
    close: int
    volume: int


class KiwoomAPI(QAxWidget):
    def __init__(self):
        super().__init__("KHOPENAPI.KHOpenAPICtrl.1")
        self.OnEventConnect.connect(self._on_event_connect)
        self.OnReceiveTrData.connect(self._on_receive_tr_data)
        self.OnReceiveRealData.connect(self._on_receive_real_data)

        self._is_connected = False
        self._orderbook_screen_no = "1000"
        self._chart_screen_no = "1001"
        self.on_quote_update = None
        self.on_chart_update = None

    @property
    def is_connected(self) -> bool:
        return self._is_connected

    def login(self):
        self.dynamicCall("CommConnect()")

    def _on_event_connect(self, err_code):
        self._is_connected = err_code == 0

    def request_orderbook(self, code: str):
        self.dynamicCall("SetInputValue(QString, QString)", "종목코드", code)
        self.dynamicCall(
            "CommRqData(QString, QString, int, QString)",
            "호가조회",
            "OPT10004",
            0,
            self._orderbook_screen_no,
        )

    def request_minute_candles(self, code: str, minute_unit: int, count: int = 120):
        self.dynamicCall("SetInputValue(QString, QString)", "종목코드", code)
        self.dynamicCall("SetInputValue(QString, QString)", "틱범위", str(minute_unit))
        self.dynamicCall("SetInputValue(QString, QString)", "수정주가구분", "1")
        self.dynamicCall(
            "CommRqData(QString, QString, int, QString)",
            f"분봉조회_{minute_unit}",
            "OPT10080",
            0,
            self._chart_screen_no,
        )

    def subscribe_orderbook_realtime(self, code: str):
        fid_list = "41;42;43;44;45;46;47;48;49;50;51;52;53;54;55;56;57;58;59;60;61;62;63;64;65;66;67;68;69;70;71;72;73;74;75;76;77;78;79;80"
        self.dynamicCall(
            "SetRealReg(QString, QString, QString, QString)",
            self._orderbook_screen_no,
            code,
            fid_list,
            "0",
        )

    def _on_receive_tr_data(self, screen_no, rq_name, tr_code, record_name, prev_next, *_):
        if rq_name == "호가조회":
            levels = self._extract_quote_levels(tr_code, rq_name)
            if self.on_quote_update:
                self.on_quote_update(levels)
            return

        if rq_name.startswith("분봉조회_"):
            candles = self._extract_minute_candles(tr_code, rq_name)
            if self.on_chart_update:
                self.on_chart_update(candles)

    def _on_receive_real_data(self, code, real_type, real_data):
        if real_type != "주식호가잔량":
            return
        levels = self._extract_quote_levels_realtime(code)
        if self.on_quote_update:
            self.on_quote_update(levels)

    def _extract_quote_levels(self, tr_code: str, rq_name: str) -> List[QuoteLevel]:
        levels = []
        for i in range(10):
            idx = i + 1
            ask_price = self._comm_data_to_int(
                self.dynamicCall("GetCommData(QString, QString, int, QString)", tr_code, rq_name, 0, f"매도호가{idx}")
            )
            ask_volume = self._comm_data_to_int(
                self.dynamicCall("GetCommData(QString, QString, int, QString)", tr_code, rq_name, 0, f"매도호가수량{idx}")
            )
            bid_price = self._comm_data_to_int(
                self.dynamicCall("GetCommData(QString, QString, int, QString)", tr_code, rq_name, 0, f"매수호가{idx}")
            )
            bid_volume = self._comm_data_to_int(
                self.dynamicCall("GetCommData(QString, QString, int, QString)", tr_code, rq_name, 0, f"매수호가수량{idx}")
            )
            levels.append(QuoteLevel(ask_price, ask_volume, bid_price, bid_volume))
        return levels

    def _extract_quote_levels_realtime(self, code: str) -> List[QuoteLevel]:
        levels = []
        for i in range(10):
            ask_price_fid = 41 + i
            bid_price_fid = 51 + i
            ask_volume_fid = 61 + i
            bid_volume_fid = 71 + i
            ask_price = self._comm_data_to_int(self.dynamicCall("GetCommRealData(QString, int)", code, ask_price_fid))
            bid_price = self._comm_data_to_int(self.dynamicCall("GetCommRealData(QString, int)", code, bid_price_fid))
            ask_volume = self._comm_data_to_int(self.dynamicCall("GetCommRealData(QString, int)", code, ask_volume_fid))
            bid_volume = self._comm_data_to_int(self.dynamicCall("GetCommRealData(QString, int)", code, bid_volume_fid))
            levels.append(QuoteLevel(ask_price, ask_volume, bid_price, bid_volume))
        return levels

    def _extract_minute_candles(self, tr_code: str, rq_name: str) -> List[Candle]:
        candles: List[Candle] = []
        repeat_cnt = int(self.dynamicCall("GetRepeatCnt(QString, QString)", tr_code, rq_name))
        for i in range(repeat_cnt):
            dt_raw = str(self.dynamicCall("GetCommData(QString, QString, int, QString)", tr_code, rq_name, i, "체결시간")).strip()
            if len(dt_raw) < 12:
                continue
            dt = datetime.strptime(dt_raw[:12], "%Y%m%d%H%M")
            open_price = self._comm_data_to_int(self.dynamicCall("GetCommData(QString, QString, int, QString)", tr_code, rq_name, i, "시가"))
            high_price = self._comm_data_to_int(self.dynamicCall("GetCommData(QString, QString, int, QString)", tr_code, rq_name, i, "고가"))
            low_price = self._comm_data_to_int(self.dynamicCall("GetCommData(QString, QString, int, QString)", tr_code, rq_name, i, "저가"))
            close_price = self._comm_data_to_int(self.dynamicCall("GetCommData(QString, QString, int, QString)", tr_code, rq_name, i, "현재가"))
            volume = self._comm_data_to_int(self.dynamicCall("GetCommData(QString, QString, int, QString)", tr_code, rq_name, i, "거래량"))
            candles.append(Candle(dt, open_price, high_price, low_price, close_price, volume))
        candles.reverse()
        return candles

    def send_order(self, account_no: str, code: str, order_type: int, quantity: int, price: int, hoga_type: str):
        return self.dynamicCall(
            "SendOrder(QString, QString, QString, int, QString, int, int, QString, QString)",
            "호가주문",
            self._orderbook_screen_no,
            account_no,
            order_type,
            code,
            quantity,
            price,
            hoga_type,
            "",
        )

    @staticmethod
    def _comm_data_to_int(value) -> int:
        if value is None:
            return 0
        text = str(value).strip().replace("+", "").replace("-", "")
        if not text:
            return 0
        try:
            return int(text)
        except ValueError:
            return 0


class CandleChartWidget(QWidget):
    def __init__(self):
        super().__init__()
        layout = QVBoxLayout(self)
        self.figure = Figure(figsize=(8, 4), tight_layout=True)
        self.canvas = FigureCanvas(self.figure)
        self.ax = self.figure.add_subplot(111)
        self.ax.set_title("분봉 차트")
        self.ax.set_xlabel("캔들")
        self.ax.set_ylabel("가격")
        layout.addWidget(self.canvas)

        self.candles: List[Candle] = []
        self.visible_count = 50
        self.canvas.mpl_connect("scroll_event", self._on_scroll)

    def set_candles(self, candles: List[Candle], minute_unit: int):
        self.candles = candles
        self.ax.set_title(f"{minute_unit}분봉 차트 (휠 확대/축소)")
        self._draw()

    def _on_scroll(self, event):
        if event.button == "up":
            self.visible_count = max(20, self.visible_count - 5)
        else:
            self.visible_count = min(max(20, len(self.candles)), self.visible_count + 5)
        self._draw()

    def _draw(self):
        self.ax.clear()
        if not self.candles:
            self.ax.set_title("분봉 차트")
            self.canvas.draw_idle()
            return

        view = self.candles[-self.visible_count :]
        xs = range(len(view))

        for x, c in zip(xs, view):
            color = "#d62728" if c.close >= c.open else "#1f77b4"
            self.ax.vlines(x, c.low, c.high, color=color, linewidth=1)
            body_low = min(c.open, c.close)
            body_high = max(c.open, c.close)
            body_h = max(1, body_high - body_low)
            self.ax.add_patch(Rectangle((x - 0.35, body_low), 0.7, body_h, facecolor=color, edgecolor=color, linewidth=1))

        labels = [c.dt.strftime("%H:%M") for c in view]
        step = max(1, len(labels) // 8)
        tick_pos = list(range(0, len(labels), step))
        self.ax.set_xticks(tick_pos)
        self.ax.set_xticklabels([labels[i] for i in tick_pos], rotation=30, ha="right")
        self.ax.grid(alpha=0.25)
        self.canvas.draw_idle()


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("키움 호가 주문기 + 분봉 차트")
        self.resize(1200, 760)

        self.api = KiwoomAPI()
        self.api.on_quote_update = self.update_orderbook
        self.api.on_chart_update = self.update_chart

        root = QWidget()
        root_layout = QVBoxLayout(root)

        conn_box = QGroupBox("연결/종목")
        conn_layout = QGridLayout(conn_box)

        self.account_input = QLineEdit()
        self.account_input.setPlaceholderText("계좌번호(하이픈 제외)")

        self.code_input = QLineEdit()
        self.code_input.setPlaceholderText("종목코드 예: 005930")

        self.status_label = QLabel("미연결")

        self.login_btn = QPushButton("로그인")
        self.login_btn.clicked.connect(self.login)

        self.load_btn = QPushButton("호가/차트 조회")
        self.load_btn.clicked.connect(self.load_data)

        self.interval_combo = QComboBox()
        self.interval_combo.addItems(["1", "5", "20", "60"])
        self.interval_combo.setCurrentText("1")
        self.interval_combo.currentTextChanged.connect(lambda _: self.load_chart_only())

        conn_layout.addWidget(QLabel("계좌"), 0, 0)
        conn_layout.addWidget(self.account_input, 0, 1)
        conn_layout.addWidget(QLabel("종목코드"), 0, 2)
        conn_layout.addWidget(self.code_input, 0, 3)
        conn_layout.addWidget(QLabel("분봉"), 0, 4)
        conn_layout.addWidget(self.interval_combo, 0, 5)
        conn_layout.addWidget(self.login_btn, 1, 0)
        conn_layout.addWidget(self.load_btn, 1, 1)
        conn_layout.addWidget(QLabel("상태"), 1, 2)
        conn_layout.addWidget(self.status_label, 1, 3, 1, 3)

        root_layout.addWidget(conn_box)

        splitter = QSplitter()

        left = QWidget()
        left_layout = QVBoxLayout(left)
        self.orderbook_table = QTableWidget(10, 4)
        self.orderbook_table.setHorizontalHeaderLabels(["매도호가", "매도잔량", "매수호가", "매수잔량"])
        self.orderbook_table.verticalHeader().setVisible(False)
        self.orderbook_table.cellClicked.connect(self.on_cell_clicked)
        left_layout.addWidget(self.orderbook_table)

        order_box = QGroupBox("주문")
        order_layout = QFormLayout(order_box)

        self.order_type_combo = QComboBox()
        self.order_type_combo.addItem("지정가", "00")
        self.order_type_combo.addItem("시장가", "03")

        self.price_input = QLineEdit()
        self.qty_input = QLineEdit("1")

        btn_layout = QHBoxLayout()
        self.buy_btn = QPushButton("매수")
        self.sell_btn = QPushButton("매도")
        self.buy_btn.clicked.connect(lambda: self.place_order(1))
        self.sell_btn.clicked.connect(lambda: self.place_order(2))
        btn_layout.addWidget(self.buy_btn)
        btn_layout.addWidget(self.sell_btn)

        order_layout.addRow("주문유형", self.order_type_combo)
        order_layout.addRow("주문가격", self.price_input)
        order_layout.addRow("수량", self.qty_input)
        order_layout.addRow(btn_layout)
        left_layout.addWidget(order_box)

        right = QWidget()
        right_layout = QVBoxLayout(right)
        self.chart_widget = CandleChartWidget()
        right_layout.addWidget(self.chart_widget)

        splitter.addWidget(left)
        splitter.addWidget(right)
        splitter.setSizes([420, 780])
        root_layout.addWidget(splitter)

        self.setCentralWidget(root)

    def login(self):
        self.api.login()
        self.status_label.setText("로그인 요청 전송")

    def _get_code(self) -> str:
        return self.code_input.text().strip()

    def _get_minute_unit(self) -> int:
        return int(self.interval_combo.currentText())

    def load_data(self):
        code = self._get_code()
        if not code:
            QMessageBox.warning(self, "입력오류", "종목코드를 입력하세요.")
            return
        if not self.api.is_connected:
            QMessageBox.warning(self, "연결오류", "먼저 로그인하세요.")
            return

        self.api.request_orderbook(code)
        self.api.subscribe_orderbook_realtime(code)
        self.api.request_minute_candles(code, self._get_minute_unit())
        self.status_label.setText(f"{code} 호가/분봉 조회 중")

    def load_chart_only(self):
        code = self._get_code()
        if not code or not self.api.is_connected:
            return
        self.api.request_minute_candles(code, self._get_minute_unit())

    def update_orderbook(self, levels: List[QuoteLevel]):
        for row, level in enumerate(levels[:10]):
            self.orderbook_table.setItem(row, 0, QTableWidgetItem(f"{level.ask_price:,}"))
            self.orderbook_table.setItem(row, 1, QTableWidgetItem(f"{level.ask_volume:,}"))
            self.orderbook_table.setItem(row, 2, QTableWidgetItem(f"{level.bid_price:,}"))
            self.orderbook_table.setItem(row, 3, QTableWidgetItem(f"{level.bid_volume:,}"))

    def update_chart(self, candles: List[Candle]):
        self.chart_widget.set_candles(candles, self._get_minute_unit())

    def on_cell_clicked(self, row: int, column: int):
        item = self.orderbook_table.item(row, column)
        if item is None or column not in (0, 2):
            return
        self.price_input.setText(item.text().replace(",", ""))

    def place_order(self, order_type: int):
        account_no = self.account_input.text().strip()
        code = self._get_code()
        qty_text = self.qty_input.text().strip()
        hoga_type = self.order_type_combo.currentData()

        if not account_no or not code or not qty_text:
            QMessageBox.warning(self, "입력오류", "계좌/종목/수량을 입력하세요.")
            return

        try:
            qty = int(qty_text)
        except ValueError:
            QMessageBox.warning(self, "입력오류", "수량은 숫자여야 합니다.")
            return

        if hoga_type == "00":
            price_text = self.price_input.text().strip()
            if not price_text:
                QMessageBox.warning(self, "입력오류", "지정가 주문은 가격이 필요합니다.")
                return
            try:
                price = int(price_text)
            except ValueError:
                QMessageBox.warning(self, "입력오류", "가격은 숫자여야 합니다.")
                return
        else:
            price = 0

        result = self.api.send_order(account_no, code, order_type, qty, price, hoga_type)
        if result == 0:
            side = "매수" if order_type == 1 else "매도"
            kind = "시장가" if hoga_type == "03" else "지정가"
            QMessageBox.information(self, "주문성공", f"{side} {kind} 주문 전송 완료")
        else:
            QMessageBox.critical(self, "주문실패", f"주문 오류 코드: {result}")


def main():
    app = QApplication(sys.argv)
    win = MainWindow()
    win.show()
    sys.exit(app.exec_())


if __name__ == "__main__":
    main()
