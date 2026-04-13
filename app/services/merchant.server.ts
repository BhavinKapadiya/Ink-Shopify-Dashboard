import firestore from "../firestore.server";

const COLLECTION = "merchants";

export interface MerchantData {
  shop: string;
  payment_status?: string;
  ink_api_key?: string;
  updatedAt?: string;
}

export const getMerchant = async (shop: string): Promise<MerchantData | null> => {
  try {
    const doc = await firestore.collection(COLLECTION).doc(shop).get();
    if (!doc.exists) return null;
    return doc.data() as MerchantData;
  } catch (error) {
    console.error("Error fetching merchant:", error);
    return null;
  }
};

export const updateMerchant = async (shop: string, data: Partial<MerchantData>) => {
  try {
    await firestore.collection(COLLECTION).doc(shop).set(
      { ...data, shop, updatedAt: new Date().toISOString() }, 
      { merge: true }
    );
  } catch (error) {
    console.error("Error updating merchant:", error);
    throw error;
  }
};
