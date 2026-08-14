/*
  Warnings:

  - A unique constraint covering the columns `[signalDeviceId]` on the table `devices` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "devices" ADD COLUMN     "signalDeviceId" INTEGER;

-- CreateIndex
CREATE UNIQUE INDEX "devices_signalDeviceId_key" ON "devices"("signalDeviceId");
