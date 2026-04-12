import { useEffect } from "react";
import { Link } from "react-router-dom";
import { useFetcher } from "react-router";
import { Button } from "~/components/ui/button";
import { AlertTriangle } from "lucide-react";
import { LowInventoryAlert } from "~/components/LowInventoryAlert";

interface InventoryData {
  remaining: number;
  total: number;
  success: boolean;
}

const NFCTagInventory = () => {
  const fetcher = useFetcher<InventoryData>();
  
  useEffect(() => {
    if (fetcher.state === "idle" && !fetcher.data) {
      fetcher.load("/app/api/dashboard/inventory");
    }
    
    // Live polling every 5 seconds
    const interval = setInterval(() => {
      if (fetcher.state === "idle") {
        fetcher.load("/app/api/dashboard/inventory");
      }
    }, 5000);
    
    return () => clearInterval(interval);
  }, [fetcher]);

  // If data exists, we consider it "loaded" so we don't flash "..." during 5-second background polling.
  // If data is entirely missing, we treat it as strictly loading to prevent the Critical banner from flashing immediately on render.
  const hasData = fetcher.data !== undefined;
  const showLoadingUI = !hasData;

  const remaining = fetcher.data?.remaining ?? 0;
  const total = fetcher.data?.total ?? 100;
  
  const percentage = total > 0 ? Math.round((remaining / total) * 100) : 0;
  const isLowInventory = remaining < 20;
  const isCriticalInventory = remaining < 10;

  const getProgressFillStyle = (): React.CSSProperties => {
    if (isCriticalInventory) {
      return {
        backgroundColor: "transparent",
        border: "2px solid #000000",
        height: "4px",
        margin: "2px",
        borderRadius: "2px",
      };
    }
    if (isLowInventory) {
      return { backgroundColor: "#FFEB3B" };
    }
    return { backgroundColor: "#000000" };
  };


  return (
    <>
      {/* Low/critical inventory alert — warning banner or blocking modal */}
      <LowInventoryAlert remaining={remaining} total={total} isLoading={showLoadingUI} />

      <div
        className="bg-card border border-border rounded-md p-4 sm:p-6 shadow-[0_1px_2px_rgba(0,0,0,0.04)]"
        role="region"
        aria-label="NFC tag inventory"
      >
        {/* Header */}
        <h3 className="text-sm sm:text-[15px] font-semibold text-foreground mb-4 sm:mb-5">
          NFC Tag Inventory
        </h3>

        {/* Count Display */}
        <div className="mb-3 sm:mb-4">
          <div className="flex items-center gap-2">
            {(isLowInventory || isCriticalInventory) && (
              <AlertTriangle 
                className="h-6 w-6" 
                style={{ color: isCriticalInventory ? "#000000" : "#FFEB3B" }}
                aria-hidden="true"
              />
            )}
            <span className="text-2xl sm:text-[32px] font-light text-foreground">
              {showLoadingUI ? "..." : `${remaining} / ${total}`}
            </span>
          </div>
          <p className="text-[13px]" style={{ color: "#666666" }}>
            remaining
          </p>
        </div>

        {/* Progress Bar */}
        <div className="relative">
          <div
            className="h-2 w-full overflow-hidden rounded-[4px]"
            style={{ backgroundColor: "#F5F5F5" }}
            role="progressbar"
            aria-valuenow={remaining}
            aria-valuemin={0}
            aria-valuemax={total}
            aria-label={`NFC tag inventory: ${remaining} of ${total} remaining`}
          >
            <div
              className="h-full transition-all duration-300 ease-out rounded-[4px]"
              style={{
                width: `${percentage}%`,
                ...getProgressFillStyle(),
              }}
            />
          </div>
          <p 
            className="text-[13px] text-right mt-1"
            style={{ color: "#666666" }}
            aria-hidden="true"
          >
            {percentage}%
          </p>
        </div>

        {/* Reorder Button */}
        <Button
          asChild
          variant="outline"
          className={`w-full mt-4 text-sm font-medium py-5 rounded-[4px] transition-colors focus-visible:ring-2 focus-visible:ring-foreground focus-visible:ring-offset-2 ${
            isLowInventory || isCriticalInventory
              ? "bg-foreground text-background hover:bg-foreground/90 border-foreground"
              : "border-border hover:border-foreground"
          }`}
        >
          <a href="https://shop.in.ink" target="_blank" rel="noopener noreferrer">
            {isCriticalInventory ? "Reorder Now" : "Reorder Tags"}
          </a>
        </Button>
      </div>
    </>
  );
};

export default NFCTagInventory;

