import sys
from dataclasses import dataclass
from typing import List, Optional

from PyQt5.QtCore import Qt
from PyQt5.QAxContainer import QAxWidget
from PyQt5.QtWidgets import (
    QApplication,
    QFormLayout,
    QGridLayout,
    QGroupBox,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QMainWindow,
    QMessageBox,
    QPushButton,
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


class KiwoomAPI(QAxWidget):
    """Kiwoom OpenAPI wrapper.

    NOTE:
    - Must run on Windows where Kiwoom OpenAPI+ is installed.
    - Event FID mapping can differ per market; adjust if needed.
    """

    def __init__(self):
        super().__init__("KHOPENAPI.KHOpenAPICtrl.1")
        self.OnEventConnect.connect(self._on_event_connect)
        self.OnReceiveTrData.connect(self._on_receive_tr_data)
        self.OnReceiveRealData.connect(self._on_receive_real_data)

        self._is_connected = False
        self._screen_no = "1000"
        self._quote_levels: List[QuoteLevel] = []
        self.on_quote_update = None

    @property
    def is_connected(self) -> bool:
        return self._is_connected

    def login(self):
        self.dynamicCall("CommConnect()")

    def _on_event_connect(self, err_code):
        self._is_connected = err_code == 0

    def request_orderbook(self, code: str):
        """Request current orderbook snapshot via OPT10004."""
        self.dynamicCall("SetInputValue(QString, QString)", "종목코드", code)
        self.dynamicCall(
            "CommRqData(QString, QString, int, QString)",
            "호가조회",
            "OPT10004",
            0,
            self._screen_no,
        )

    def subscribe_orderbook_realtime(self, code: str):
        # 41~60: 매도/매수호가, 61~80: 매도/매수호가잔량 (환경에 맞게 조정 가능)
        fid_list = "41;42;43;44;45;46;47;48;49;50;51;52;53;54;55;56;57;58;59;60;61;62;63;64;65;66;67;68;69;70;71;72;73;74;75;76;77;78;79;80"
        self.dynamicCall(
            "SetRealReg(QString, QString, QString, QString)",
            self._screen_no,
            code,
            fid_list,
            "0",
        )

    def _on_receive_tr_data(self, screen_no, rq_name, tr_code, record_name, prev_next, *_):
        if rq_name != "호가조회":
            return
        self._quote_levels = self._extract_quote_levels(tr_code, rq_name)
        if self.on_quote_update:
            self.on_quote_update(self._quote_levels)

    def _on_receive_real_data(self, code, real_type, real_data):
        if real_type != "주식호가잔량":
            return
        self._quote_levels = self._extract_quote_levels_realtime(code)
        if self.on_quote_update:
            self.on_quote_update(self._quote_levels)

    def _extract_quote_levels(self, tr_code: str, rq_name: str) -> List[QuoteLevel]:
        levels = []
        for i in range(10):
            ask_price = self._comm_data_to_int(
                self.dynamicCall(
                    "GetCommData(QString, QString, int, QString)", tr_code, rq_name, 0, f"매도최우선호가{i+1}"
                )
            )
            ask_volume = self._comm_data_to_int(
                self.dynamicCall(
                    "GetCommData(QString, QString, int, QString)", tr_code, rq_name, 0, f"매도최우선잔량{i+1}"
                )
            )
            bid_price = self._comm_data_to_int(
                self.dynamicCall(
                    "GetCommData(QString, QString, int, QString)", tr_code, rq_name, 0, f"매수최우선호가{i+1}"
                )
            )
            bid_volume = self._comm_data_to_int(
                self.dynamicCall(
                    "GetCommData(QString, QString, int, QString)", tr_code, rq_name, 0, f"매수최우선잔량{i+1}"
                )
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
            ask_price = self._comm_data_to_int(
                self.dynamicCall("GetCommRealData(QString, int)", code, ask_price_fid)
            )
            bid_price = self._comm_data_to_int(
                self.dynamicCall("GetCommRealData(QString, int)", code, bid_price_fid)
            )
            ask_volume = self._comm_data_to_int(
                self.dynamicCall("GetCommRealData(QString, int)", code, ask_volume_fid)
            )
            bid_volume = self._comm_data_to_int(
                self.dynamicCall("GetCommRealData(QString, int)", code, bid_volume_fid)
            )
            levels.append(QuoteLevel(ask_price, ask_volume, bid_price, bid_volume))
        return levels

    def send_order(
        self,
        account_no: str,
        code: str,
        order_type: int,
        quantity: int,
        price: int,
        hoga_type: str,
    ):
        # order_type: 1=신규매수, 2=신규매도
        return self.dynamicCall(
            "SendOrder(QString, QString, QString, int, QString, int, int, QString, QString)",
            "호가주문",
            self._screen_no,
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


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("키움 호가 주문기")
        self.resize(820, 560)

        self.api = KiwoomAPI()
        self.api.on_quote_update = self.update_orderbook

        root = QWidget()
        layout = QVBoxLayout(root)

        conn_box = QGroupBox("연결/종목")
        conn_layout = QGridLayout(conn_box)

        self.account_input = QLineEdit()
        self.account_input.setPlaceholderText("계좌번호(하이픈 제외)")

        self.code_input = QLineEdit()
        self.code_input.setPlaceholderText("종목코드 예: 005930")

        self.status_label = QLabel("미연결")

        self.login_btn = QPushButton("로그인")
        self.login_btn.clicked.connect(self.login)

        self.load_btn = QPushButton("호가조회")
        self.load_btn.clicked.connect(self.load_orderbook)

        conn_layout.addWidget(QLabel("계좌"), 0, 0)
        conn_layout.addWidget(self.account_input, 0, 1)
        conn_layout.addWidget(QLabel("종목코드"), 0, 2)
        conn_layout.addWidget(self.code_input, 0, 3)
        conn_layout.addWidget(self.login_btn, 1, 0)
        conn_layout.addWidget(self.load_btn, 1, 1)
        conn_layout.addWidget(QLabel("상태"), 1, 2)
        conn_layout.addWidget(self.status_label, 1, 3)

        layout.addWidget(conn_box)

        self.orderbook_table = QTableWidget(10, 4)
        self.orderbook_table.setHorizontalHeaderLabels(["매도호가", "매도잔량", "매수호가", "매수잔량"])
        self.orderbook_table.verticalHeader().setVisible(False)
        self.orderbook_table.cellClicked.connect(self.on_cell_clicked)
        layout.addWidget(self.orderbook_table)

        order_box = QGroupBox("주문")
        order_layout = QFormLayout(order_box)

        self.price_input = QLineEdit()
        self.qty_input = QLineEdit()
        self.qty_input.setText("1")

        btn_layout = QHBoxLayout()
        self.buy_btn = QPushButton("매수")
        self.sell_btn = QPushButton("매도")
        self.buy_btn.clicked.connect(lambda: self.place_order(1))
        self.sell_btn.clicked.connect(lambda: self.place_order(2))
        btn_layout.addWidget(self.buy_btn)
        btn_layout.addWidget(self.sell_btn)

        order_layout.addRow("주문가격", self.price_input)
        order_layout.addRow("수량", self.qty_input)
        order_layout.addRow(btn_layout)

        layout.addWidget(order_box)
        self.setCentralWidget(root)

    def login(self):
        self.api.login()
        self.status_label.setText("로그인 요청 전송")

    def load_orderbook(self):
        code = self.code_input.text().strip()
        if not code:
            QMessageBox.warning(self, "입력오류", "종목코드를 입력하세요.")
            return
        if not self.api.is_connected:
            QMessageBox.warning(self, "연결오류", "먼저 로그인하세요.")
            return
        self.api.request_orderbook(code)
        self.api.subscribe_orderbook_realtime(code)
        self.status_label.setText(f"{code} 호가 구독 중")

    def update_orderbook(self, levels: List[QuoteLevel]):
        for row, level in enumerate(levels[:10]):
            self.orderbook_table.setItem(row, 0, QTableWidgetItem(f"{level.ask_price:,}"))
            self.orderbook_table.setItem(row, 1, QTableWidgetItem(f"{level.ask_volume:,}"))
            self.orderbook_table.setItem(row, 2, QTableWidgetItem(f"{level.bid_price:,}"))
            self.orderbook_table.setItem(row, 3, QTableWidgetItem(f"{level.bid_volume:,}"))

    def on_cell_clicked(self, row: int, column: int):
        item = self.orderbook_table.item(row, column)
        if item is None:
            return
        if column in (0, 2):
            self.price_input.setText(item.text().replace(",", ""))

    def place_order(self, order_type: int):
        account_no = self.account_input.text().strip()
        code = self.code_input.text().strip()
        price_text = self.price_input.text().strip()
        qty_text = self.qty_input.text().strip()

        if not account_no or not code or not price_text or not qty_text:
            QMessageBox.warning(self, "입력오류", "계좌/종목/가격/수량을 모두 입력하세요.")
            return

        try:
            price = int(price_text)
            qty = int(qty_text)
        except ValueError:
            QMessageBox.warning(self, "입력오류", "가격/수량은 숫자여야 합니다.")
            return

        # 00: 지정가
        result = self.api.send_order(account_no, code, order_type, qty, price, "00")
        if result == 0:
            action = "매수" if order_type == 1 else "매도"
            QMessageBox.information(self, "주문성공", f"{action} 주문 전송 완료")
        else:
            QMessageBox.critical(self, "주문실패", f"주문 오류 코드: {result}")


def main():
    app = QApplication(sys.argv)
    win = MainWindow()
    win.show()
    sys.exit(app.exec_())


if __name__ == "__main__":
    main()
