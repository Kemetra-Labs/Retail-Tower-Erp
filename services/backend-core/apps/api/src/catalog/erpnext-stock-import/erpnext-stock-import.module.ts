/**
 * ErpnextStockImportModule — RT-1288. The Backend-Core side of the ERP-origin
 * stock import feed (`erpnext-connector/stock-import.yaml`): Backend-Core
 * EXPOSES the feed of wanted Stock Ledger reads and records the Connector's
 * reports; the Connector (RT-1287) is the only ERPNext-calling component (§IX).
 * Mirrors `ErpnextBinViewModule`: the machine connector bearer, audit and
 * tenant context. Tables: 0096 (`erp_stock_import_*`).
 */
import { Module } from "@nestjs/common";

import { AuditModule } from "../../audit/audit.module";
import { AuthModule } from "../../auth/auth.module";
import { ContextModule } from "../../context/context.module";
import { ErpnextStockImportController } from "./erpnext-stock-import.controller";
import { ErpnextStockImportService } from "./erpnext-stock-import.service";

@Module({
  imports: [AuthModule, AuditModule, ContextModule],
  controllers: [ErpnextStockImportController],
  providers: [ErpnextStockImportService],
})
export class ErpnextStockImportModule {}
